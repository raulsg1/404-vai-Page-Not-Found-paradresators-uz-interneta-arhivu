// ==UserScript==
// @name         Archive Finder Prototype
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Neeksistējošu lapu arhivēto versiju meklēšana
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      archive.org
// @connect      web.archive.org
// @exclude      *://search.brave.com/*
// @exclude      *://www.google.com/search*
// @exclude      *://duckduckgo.com/*
// @exclude      *://www.bing.com/search*
// ==/UserScript==

(function() {
    'use strict';

    // ===== MODULIS: Iestatījumi (lokāla glabāšana) =====
    const Settings = {
        get() {
            return GM_getValue('settings', {
                autoRedirect: false,
                notifications: true,
                cacheEnabled: true,
                timeout: 20000
            });
        },
        save(newSettings) {
            GM_setValue('settings', newSettings);
        }
    };

    // ===== MODULIS: Lapas analīze (A sadaļa) =====
    const PageAnalyzer = {
        checkHttpStatus() {
            const nav = performance.getEntriesByType('navigation')[0];
            return nav ? nav.responseStatus : null;
        },

        // URL 404 pazīmju pārbaude
        checkUrl() {
            const url = window.location.href.toLowerCase();
            const urlPatterns = [
                'not-found', '404', 'page-not-found', 'error-404'
            ];
            const hasPattern = urlPatterns.some(p => url.includes(p));
            return { isNotFound: hasPattern, reason: 'url' };
        },

        analyzeDom() {
            // 1. Lapas virsraksta (<title>) pārbaude
            const title = document.title?.toLowerCase() || '';

            // 2. Galveno virsrakstu (<h1>, <h2>, <h3>) pārbaude
            const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
                .map(el => el.innerText?.toLowerCase() || '')
                .join(' ');

            // 3. Īsu elementu (span, div, a, p) pārbaude
            const shortElements = Array.from(document.querySelectorAll('span, div, a, p'))
                .filter(el => {
                    const text = el.innerText?.toLowerCase() || '';
                    // Tikai elementi līdz 150 rakstzīmēm
                    return text.length > 0 && text.length < 150;
                })
                .map(el => el.innerText?.toLowerCase() || '')
                .join(' ');

            // 4. 404 pazīmju saraksts
            const notFoundPatterns = [
                'page not found', '404 not found', 'error 404', '404 error',
                'does not exist', 'doesn\'t exist',
                'lapa nav atrasta', 'lapaspuse nav atrasta', 'nav atrasta', 'neeksistē'
            ];

            // Pazīmju meklēšana iegūtajos tekstos
            const hasPattern = notFoundPatterns.some(p =>
                title.includes(p) ||
                headings.includes(p) ||
                shortElements.includes(p)
            );

            return { isNotFound: hasPattern, reason: 'dom' };
        },

        detect404() {
            const httpStatus = this.checkHttpStatus();
            const urlResult = this.checkUrl();
            const domResult = this.analyzeDom();

            // 404 atpazīšana pēc trim kritērijiem
            const is404 = (httpStatus === 404) || urlResult.isNotFound || domResult.isNotFound;

            let reason = null;
            if (httpStatus === 404) reason = 'http';
            else if (urlResult.isNotFound) reason = 'url';
            else if (domResult.isNotFound) reason = 'dom';

            return { is404, reason };
        }
    };

    // ===== MODULIS: URL apstrāde (B sadaļa) =====
    const UrlProcessor = {
        normalize(rawUrl) {
            try {
                const url = new URL(rawUrl);
                url.hash = '';
                let hostname = url.hostname.toLowerCase();
                const keepParams = ['id', 'page', 'article'];
                const params = new URLSearchParams(url.search);
                const newParams = new URLSearchParams();
                keepParams.forEach(p => {
                    if (params.has(p)) newParams.set(p, params.get(p));
                });
                url.search = newParams.toString();
                return url.toString();
            } catch (e) {
                return null;
            }
        }
    };

    // ===== MODULIS: Arhīva meklēšana + kešatmiņa (C sadaļa) =====
    const ArchiveSearcher = {
        getCacheKey(url) {
            return 'archive_cache:' + url;
        },
        getFromCache(url) {
            const cached = GM_getValue(this.getCacheKey(url), null);
            if (cached && (Date.now() - cached.cachedAt < 3600000)) { // 1h
                return cached.snapshots;
            }
            return null;
        },
        saveToCache(url, snapshots) {
            GM_setValue(this.getCacheKey(url), {
                snapshots,
                cachedAt: Date.now()
            });
        },
        async search(normalizedUrl, timeout) {
            const cached = this.getFromCache(normalizedUrl);
            if (cached) return { snapshots: cached, fromCache: true };

            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    reject(new Error('Timeout'));
                }, timeout);

                GM_xmlhttpRequest({
                    method: 'GET',
                    url: `https://archive.org/wayback/available?url=${encodeURIComponent(normalizedUrl)}`,
                    onload: (response) => {
                        clearTimeout(timer);
                        console.log('🔍 API statuss:', response.status);
                        console.log('🔍 API atbilde:', response.responseText);

                        if (response.status !== 200) {
                            reject(new Error(`API atgrieza statusu ${response.status}`));
                            return;
                        }

                        const text = response.responseText || response.response;
                        if (!text || text.trim() === '') {
                            reject(new Error('API atgrieza tukšu atbildi'));
                            return;
                        }

                        try {
                            const data = JSON.parse(text);
                            let snapshots = [];
                            if (data.archived_snapshots?.closest) {
                                snapshots = [{
                                    snapshotDate: data.archived_snapshots.closest.timestamp,
                                    archiveUrl: data.archived_snapshots.closest.url,
                                    originalUrl: normalizedUrl
                                }];
                            }
                            this.saveToCache(normalizedUrl, snapshots);
                            resolve({ snapshots, fromCache: false });
                        } catch (e) {
                            console.error('Nederīgs JSON no API:', text.substring(0, 500));
                            reject(new Error('Nederīga API atbilde'));
                        }
                    },
                    onerror: () => {
                        clearTimeout(timer);
                        reject(new Error('API nav pieejams'));
                    }
                });
            });
        }
    };

    // ===== MODULIS: UI (vizuāli logi) =====
    const UI = {
        showNotFoundDialog(url, onSearch) {
            document.getElementById('archive-finder-dialog')?.remove();

            const dialog = document.createElement('div');
            dialog.id = 'archive-finder-dialog';
            dialog.style.cssText = `
                position: fixed; top: 20px; right: 20px; z-index: 999999;
                background: #1a1a1a; color: #fff; border: 2px solid #444;
                border-radius: 8px; padding: 16px; width: 400px;
                font-family: Arial, sans-serif; box-shadow: 0 4px 12px rgba(0,0,0,0.5);
            `;
            dialog.innerHTML = `
                <div style="font-weight: bold; margin-bottom: 12px;">Archive Finder</div>
                <p>Neizdevās atrast pieprasīto lapu.</p>
                <p style="color: #aaa; font-size: 12px; word-break: break-all;">${url}</p>
                <p>Meklēt iepriekšējo versiju Internet Archive?</p>
                <div style="display: flex; gap: 8px; margin-top: 12px;">
                    <button id="af-search" style="flex:1; padding:8px; background:#2563eb; color:#fff; border:none; border-radius:4px; cursor:pointer;">Mēģināt vēlreiz</button>
                    <button id="af-settings" style="flex:1; padding:8px; background:#7c3aed; color:#fff; border:none; border-radius:4px; cursor:pointer;">Iestatījumi</button>
                    <button id="af-data" style="flex:1; padding:8px; background:#059669; color:#fff; border:none; border-radius:4px; cursor:pointer;">Dati</button>
                    <button id="af-cancel" style="flex:1; padding:8px; background:#444; color:#fff; border:none; border-radius:4px; cursor:pointer;">Atcelt</button>
                </div>
            `;
            document.body.appendChild(dialog);
            document.getElementById('af-search').onclick = () => {
                dialog.remove();
                onSearch();
            };
            document.getElementById('af-cancel').onclick = () => dialog.remove();
            document.getElementById('af-settings').onclick = () => {
                dialog.remove();
                this.showSettingsDialog();
            };
            document.getElementById('af-data').onclick = () => {
                dialog.remove();
                this.showDataViewer();
            };
        },

        showLoadingDialog(url) {
            document.getElementById('archive-finder-loading')?.remove();
            const dialog = document.createElement('div');
            dialog.id = 'archive-finder-loading';
            dialog.style.cssText = `
                position: fixed; top: 20px; right: 20px; z-index: 999999;
                background: #1a1a1a; color: #fff; border: 2px solid #444;
                border-radius: 8px; padding: 16px; width: 400px;
                font-family: Arial, sans-serif;
            `;
            dialog.innerHTML = `
                <div style="font-weight: bold; margin-bottom: 12px;">Meklēšana arhīvā</div>
                <p>Notiek meklēšana:</p>
                <p style="color: #aaa; font-size: 12px; word-break: break-all;">${url}</p>
                <div style="margin-top: 12px; text-align: center;">
                    <div style="display:inline-block; width:20px; height:20px; border:3px solid #444; border-top-color:#2563eb; border-radius:50%; animation: af-spin 1s linear infinite;"></div>
                </div>
                <style>@keyframes af-spin { to { transform: rotate(360deg); } }</style>
            `;
            document.body.appendChild(dialog);
        },

        showResultsDialog(snapshots, onOpen) {
            document.getElementById('archive-finder-loading')?.remove();
            const dialog = document.createElement('div');
            dialog.style.cssText = `
                position: fixed; top: 20px; right: 20px; z-index: 999999;
                background: #1a1a1a; color: #fff; border: 2px solid #444;
                border-radius: 8px; padding: 16px; width: 400px;
                font-family: Arial, sans-serif;
            `;
            const list = snapshots.map((s, i) =>
                `<li style="margin:6px 0; display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-size:13px;">${s.snapshotDate}</span>
                    <button data-url="${s.archiveUrl}" class="af-open" style="padding:3px 10px; background:#2563eb; color:#fff; border:none; border-radius:3px; cursor:pointer;">Atvērt</button>
                </li>`
            ).join('');
            dialog.innerHTML = `
                <div style="font-weight: bold; margin-bottom: 12px;">Atrastās arhivētās lapas</div>
                <p>Pieejamās versijas:</p>
                <ul style="list-style:none; padding:0; margin:8px 0;">${list}</ul>
                <div style="display:flex; gap:8px; margin-top:12px;">
                    <button id="af-open-recommended" style="flex:1; padding:8px; background:#2563eb; color:#fff; border:none; border-radius:4px; cursor:pointer;">Atvērt ieteikto</button>
                    <button id="af-close-results" style="flex:1; padding:8px; background:#444; color:#fff; border:none; border-radius:4px; cursor:pointer;">Atcelt</button>
                </div>
            `;
            document.body.appendChild(dialog);
            dialog.querySelectorAll('.af-open').forEach(btn => {
                btn.onclick = () => onOpen(btn.dataset.url);
            });
            document.getElementById('af-open-recommended').onclick = () => {
                if (snapshots.length > 0) onOpen(snapshots[0].archiveUrl);
            };
            document.getElementById('af-close-results').onclick = () => dialog.remove();
        },

        showErrorDialog(message) {
            document.getElementById('archive-finder-loading')?.remove();
            const dialog = document.createElement('div');
            dialog.style.cssText = `
                position: fixed; top: 20px; right: 20px; z-index: 999999;
                background: #1a1a1a; color: #fff; border: 2px solid #444;
                border-radius: 8px; padding: 16px; width: 400px;
                font-family: Arial, sans-serif;
            `;
            dialog.innerHTML = `
                <div style="font-weight: bold; margin-bottom: 12px;">Kļūda</div>
                <p>${message}</p>
                <button id="af-close-error" style="margin-top:12px; padding:8px 16px; background:#444; color:#fff; border:none; border-radius:4px; cursor:pointer;">Aizvērt</button>
            `;
            document.body.appendChild(dialog);
            document.getElementById('af-close-error').onclick = () => dialog.remove();
        },

        showSettingsDialog() {
            document.getElementById('af-settings-dialog')?.remove();
            const settings = Settings.get();
            const dialog = document.createElement('div');
            dialog.id = 'af-settings-dialog';
            dialog.style.cssText = `
                position: fixed; top: 20px; right: 20px; z-index: 999999;
                background: #1a1a1a; color: #fff; border: 2px solid #444;
                border-radius: 8px; padding: 16px; width: 400px;
                font-family: Arial, sans-serif;
            `;
            dialog.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 12px;">
                    <div style="font-weight: bold;">Archive Finder - Iestatījumi</div>
                    <button id="af-close-settings-x" style="background:none; border:none; color:#fff; font-size:16px; cursor:pointer;">✕</button>
                </div>
                <div style="margin:8px 0;">Automātiska pāradresācija
                    <button id="af-toggle-auto" style="float:right; padding:2px 8px; background:#2563eb; color:#fff; border:none; border-radius:3px; cursor:pointer;">${settings.autoRedirect ? 'ON' : 'OFF'}</button>
                </div>
                <div style="margin:8px 0;">Rādīt paziņojumus
                    <button id="af-toggle-notif" style="float:right; padding:2px 8px; background:#2563eb; color:#fff; border:none; border-radius:3px; cursor:pointer;">${settings.notifications ? 'ON' : 'OFF'}</button>
                </div>
                <div style="margin:8px 0;">Izmantot kešatmiņu
                    <button id="af-toggle-cache" style="float:right; padding:2px 8px; background:#2563eb; color:#fff; border:none; border-radius:3px; cursor:pointer;">${settings.cacheEnabled ? 'ON' : 'OFF'}</button>
                </div>
                <div style="margin:8px 0;">Timeout: ${settings.timeout / 1000} sek.</div>
                <button id="af-save-settings" style="margin-top:12px; padding:8px 16px; background:#2563eb; color:#fff; border:none; border-radius:4px; cursor:pointer; width:100%;">Saglabāt</button>
            `;
            document.body.appendChild(dialog);

            let temp = { ...settings };
            const toggle = (key, btnId) => {
                temp[key] = !temp[key];
                document.getElementById(btnId).textContent = temp[key] ? 'ON' : 'OFF';
            };
            document.getElementById('af-toggle-auto').onclick = () => toggle('autoRedirect', 'af-toggle-auto');
            document.getElementById('af-toggle-notif').onclick = () => toggle('notifications', 'af-toggle-notif');
            document.getElementById('af-toggle-cache').onclick = () => toggle('cacheEnabled', 'af-toggle-cache');
            document.getElementById('af-close-settings-x').onclick = () => dialog.remove();
            document.getElementById('af-save-settings').onclick = () => {
                Settings.save(temp);
                dialog.remove();
            };
        },

        // === AUTOMĀTISKĀS PĀRADRESĀCIJAS APSTIPRINĀJUMA LOGS (11. att.) ===
        showAutoRedirectDialog(snapshot, onConfirm) {
            document.getElementById('archive-finder-loading')?.remove();
            document.getElementById('af-auto-redirect-dialog')?.remove();

            // Datuma formāts (YYYY-MM-DD HH:MM)
            let formattedDate = snapshot.snapshotDate;
            try {
                const ts = snapshot.snapshotDate;
                if (ts.length >= 12) {
                    const y = ts.substring(0, 4);
                    const m = ts.substring(4, 6);
                    const d = ts.substring(6, 8);
                    const h = ts.substring(8, 10);
                    const min = ts.substring(10, 12);
                    formattedDate = `${y}-${m}-${d} ${h}:${min}`;
                }
            } catch (e) { /* ignorēšana */ }

            const dialog = document.createElement('div');
            dialog.id = 'af-auto-redirect-dialog';
            dialog.style.cssText = `
                position: fixed; top: 20px; right: 20px; z-index: 999999;
                background: #1a1a1a; color: #fff; border: 2px solid #444;
                border-radius: 8px; padding: 16px; width: 400px;
                font-family: Arial, sans-serif; box-shadow: 0 4px 12px rgba(0,0,0,0.5);
            `;
            dialog.innerHTML = `
                <div style="font-weight: bold; margin-bottom: 12px;">Arhivētā versija atrasta</div>
                <p style="text-align:center;">Atrasta atbilstoša lapas versija:</p>
                <p style="text-align:center; font-size:16px; font-weight:bold; color:#60a5fa;">${formattedDate}</p>
                <p style="text-align:center;">Vai atvērt arhivēto lapu?</p>
                <div style="display:flex; gap:8px; margin-top:12px;">
                    <button id="af-auto-yes" style="flex:1; padding:10px; background:#2563eb; color:#fff; border:none; border-radius:4px; cursor:pointer; font-weight:bold;">Jā</button>
                    <button id="af-auto-no" style="flex:1; padding:10px; background:#444; color:#fff; border:none; border-radius:4px; cursor:pointer;">Nē</button>
                </div>
            `;
            document.body.appendChild(dialog);

            document.getElementById('af-auto-yes').onclick = () => {
                dialog.remove();
                onConfirm(true);
            };
            document.getElementById('af-auto-no').onclick = () => {
                dialog.remove();
                onConfirm(false);
            };
        },

        // === VIENKĀRŠOTS DATU SKATĪTĀJS (tikai kešatmiņa un 4 pogas) ===
        showDataViewer() {
            document.getElementById('af-data-viewer')?.remove();

            const cacheKeys = GM_listValues().filter(k => k.startsWith('archive_cache:'));

            let cacheRows = '';
            cacheKeys.forEach(key => {
                const url = key.replace('archive_cache:', '');
                const data = GM_getValue(key);
                const date = new Date(data.cachedAt).toLocaleString('lv-LV');
                cacheRows += `
                    <tr>
                        <td style="padding:6px; border-bottom:1px solid #333; font-size:11px; word-break:break-all; color:#fff;">${url}</td>
                        <td style="padding:6px; border-bottom:1px solid #333; font-size:11px; text-align:center; color:#fff;">${data.snapshots.length}</td>
                        <td style="padding:6px; border-bottom:1px solid #333; font-size:11px; color:#fff;">${date}</td>
                    </tr>
                `;
            });

            if (!cacheRows) {
                cacheRows = '<tr><td colspan="3" style="padding:12px; text-align:center; color:#888;">Kešatmiņa ir tukša</td></tr>';
            }

            const dialog = document.createElement('div');
            dialog.id = 'af-data-viewer';
            dialog.style.cssText = `
                position: fixed; top: 20px; right: 20px; z-index: 999999;
                background: #1a1a1a; color: #fff; border: 2px solid #444;
                border-radius: 8px; padding: 16px; width: 650px;
                font-family: Arial, sans-serif; max-height: 85vh; overflow-y: auto;
                box-shadow: 0 4px 20px rgba(0,0,0,0.6);
            `;
            dialog.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 12px;">
                    <div style="font-weight: bold; font-size:15px;">Archive Finder — Kešatmiņa (${cacheKeys.length})</div>
                    <button id="af-dv-close-x" style="background:none; border:none; color:#fff; font-size:18px; cursor:pointer;">✕</button>
                </div>

                <table style="width:100%; border-collapse:collapse;">
                    <thead>
                        <tr style="background:#333;">
                            <th style="padding:6px; text-align:left; font-size:12px; color:#fff;">URL</th>
                            <th style="padding:6px; text-align:center; font-size:12px; color:#fff;">Snapshot</th>
                            <th style="padding:6px; text-align:left; font-size:12px; color:#fff;">Saglabāts</th>
                        </tr>
                    </thead>
                    <tbody>${cacheRows}</tbody>
                </table>

                <div style="display:flex; gap:8px; margin-top:16px;">
                    <button id="af-dv-refresh" style="flex:1; padding:8px; background:#2563eb; color:#fff; border:none; border-radius:4px; cursor:pointer;">🔄 Atjaunot</button>
                    <button id="af-dv-settings" style="flex:1; padding:8px; background:#7c3aed; color:#fff; border:none; border-radius:4px; cursor:pointer;">⚙️ Iestatījumi</button>
                    <button id="af-dv-clear" style="flex:1; padding:8px; background:#b91c1c; color:#fff; border:none; border-radius:4px; cursor:pointer;">🗑️ Notīrīt kešu</button>
                    <button id="af-dv-close" style="flex:1; padding:8px; background:#444; color:#fff; border:none; border-radius:4px; cursor:pointer;">Aizvērt</button>
                </div>
            `;
            document.body.appendChild(dialog);

            const close = () => dialog.remove();
            document.getElementById('af-dv-close').onclick = close;
            document.getElementById('af-dv-close-x').onclick = close;
            document.getElementById('af-dv-refresh').onclick = () => {
                dialog.remove();
                this.showDataViewer();
            };
            document.getElementById('af-dv-settings').onclick = () => {
                dialog.remove();
                this.showSettingsDialog();
            };
            document.getElementById('af-dv-clear').onclick = () => {
                if (confirm('Vai tiešām notīrīt visu arhīva kešatmiņu?')) {
                    GM_listValues()
                        .filter(k => k.startsWith('archive_cache:'))
                        .forEach(k => GM_deleteValue(k));
                    dialog.remove();
                    this.showDataViewer();
                }
            };
        }
    };

    // ===== TAMPERMONKEY IZVĒLNES KOMANDAS =====
    GM_registerMenuCommand('⚙️ Iestatījumi', () => UI.showSettingsDialog());
    GM_registerMenuCommand('💾 Mani dati', () => UI.showDataViewer());
    GM_registerMenuCommand('🗑️ Notīrīt visu kešatmiņu', () => {
        if (confirm('Vai tiešām notīrīt visu arhīva kešatmiņu un atiestatīt iestatījumus?')) {
            GM_listValues().forEach(k => GM_deleteValue(k));
            alert('Visi dati notīrīti. Pārlādējiet lapu.');
        }
    });

    // ===== GALVENĀ LOĢIKA =====
    async function main() {
        const currentUrl = window.location.href;
        const detection = PageAnalyzer.detect404();

        if (!detection.is404) return; // Lapa ir OK, nekas nav jādara

        // 404 dialoga parādīšana
        UI.showNotFoundDialog(currentUrl, async () => {
            const normalizedUrl = UrlProcessor.normalize(currentUrl);
            if (!normalizedUrl) {
                UI.showErrorDialog('Nederīga tīmekļa adrese.');
                return;
            }

            UI.showLoadingDialog(currentUrl);
            try {
                const settings = Settings.get();
                const result = await ArchiveSearcher.search(normalizedUrl, settings.timeout);

                if (result.snapshots.length === 0) {
                    // Nav atrasta neviena versija
                    UI.showErrorDialog('Šīs lapas arhivētā versija netika atrasta.');
                } else if (settings.autoRedirect) {
                    // === AUTOMĀTISKĀ PĀRADRESĀCIJA (ja ieslēgta) ===
                    UI.showAutoRedirectDialog(result.snapshots[0], (confirmed) => {
                        if (confirmed) {
                            // Pāradresācija uz arhivēto lapu
                            window.location.href = result.snapshots[0].archiveUrl;
                        } else {
                            // Lietotāja atteikšanās — rezultātu saraksta parādīšana
                            UI.showResultsDialog(result.snapshots, (archiveUrl) => {
                                window.open(archiveUrl, '_blank');
                            });
                        }
                    });
                } else {
                    // === MANUĀLĀ IZVĒLE (autoRedirect izslēgts) ===
                    UI.showResultsDialog(result.snapshots, (archiveUrl) => {
                        window.open(archiveUrl, '_blank');
                    });
                }
            } catch (e) {
                if (e.message === 'Timeout') {
                    UI.showErrorDialog('Neizdevās sazināties ar Internet Archive. Lūdzu, mēģiniet vēlāk.');
                } else {
                    UI.showErrorDialog('Kļūda, meklējot arhīvā: ' + e.message);
                }
            }
        });
    }

    // Palaide pēc lapas ielādes
    if (document.readyState === 'complete') {
        main();
    } else {
        window.addEventListener('load', main);
    }
})();
