// bypass-server.js
const http = require('http');
const puppeteer = require('puppeteer-core');
const { URL } = require('url');
const { execSync } = require('child_process');

const PORT = 3111;
const TIMEOUT = 25000;

// Find chromium path on Termux
function findChrome() {
    const candidates = [
        '/data/data/com.termux/files/usr/bin/chromium',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
    ];
    for (const p of candidates) {
        try {
            require('fs').accessSync(p, require('fs').constants.X_OK);
            return p;
        } catch (e) {}
    }
    // Try which
    try {
        return execSync('which chromium').toString().trim();
    } catch (e) {}
    return null;
}

const CHROME_PATH = findChrome();
if (!CHROME_PATH) {
    console.error('[-] Chromium not found. Install: pkg install chromium');
    process.exit(1);
}
console.log('[+] Chromium: ' + CHROME_PATH);

let browser = null;

async function getBrowser() {
    if (!browser || !browser.isConnected()) {
        browser = await puppeteer.launch({
            executablePath: CHROME_PATH,
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--single-process',
                '--no-zygote',
                '--window-size=720,1280',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-sync',
                '--disable-translate',
                '--metrics-recording-only',
                '--mute-audio',
                '--no-first-run',
            ],
        });
    }
    return browser;
}

function isShortenerDomain(host) {
    const h = host.toLowerCase();
    const p = [
        'gplinks','gp-links','gplink','gplink.co','gplinks.co','gplinks.in',
        'linkvertise','link-to','link-center','direct-link',
        'ouo.io','ouo.press','ouo.today',
        'adfly','adf.ly','j.gs','q.gs',
        'shrinkme.io','shrtfly.com','shortino','earnlink','illink','linksly',
        'rocklinks','urlpay','try2link','cety.app','mdisk','psa.wf','tnlink','cblink',
    ];
    return p.some(x => h.includes(x));
}

async function bypassPage(rawUrl) {
    const page = await (await getBrowser()).newPage();

    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const t = req.resourceType();
        if (['image','font','stylesheet','media'].includes(t)) {
            req.abort();
        } else {
            req.continue();
        }
    });

    const collected = [];
    let finalUrl = rawUrl;

    page.on('request', (req) => {
        const u = req.url();
        if (u.startsWith('http') && u !== rawUrl && !u.includes('google') && !u.includes('doubleclick')) {
            collected.push({ source: 'request', url: u });
        }
    });

    page.on('response', (resp) => {
        if (resp.status() >= 300 && resp.status() < 400) {
            const loc = resp.headers()['location'];
            if (loc) collected.push({ source: '3xx', url: loc });
        }
    });

    try {
        await page.goto(rawUrl, { waitUntil: 'networkidle2', timeout: TIMEOUT });
        finalUrl = page.url();

        if (finalUrl === rawUrl || isShortenerDomain(new URL(finalUrl).host)) {
            await new Promise(r => setTimeout(r, 6000));
            finalUrl = page.url();

            const btns = [
                '#btn-main','#btn2','#btn1','#proceed',
                'button.btn-main','button.get-link','button.redirect',
                'input[type="submit"]','.btn-primary','#submit',
                'a[href*="redirect"]','a.btn','button:not([disabled])',
            ];

            for (const sel of btns) {
                try {
                    const btn = await page.$(sel);
                    if (btn && await btn.isVisible()) {
                        await btn.click();
                        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(() => {});
                        finalUrl = page.url();
                        break;
                    }
                } catch (e) {}
            }

            await new Promise(r => setTimeout(r, 4000));
            finalUrl = page.url();
        }

        const pageUrls = await page.evaluate(() => {
            const urls = new Set();
            document.querySelectorAll('a[href]').forEach(a => {
                try { urls.add(new URL(a.href, location.origin).href); } catch(e) {}
            });
            document.querySelectorAll('meta[http-equiv="refresh"]').forEach(m => {
                const c = m.getAttribute('content') || '';
                const m2 = c.match(/url=(.+)/i);
                if (m2) try { urls.add(new URL(m2[1], location.origin).href); } catch(e) {}
            });
            document.querySelectorAll('script').forEach(s => {
                const t = s.textContent || '';
                const um = t.match(/https?:\/\/[^\s"'<>]+/g);
                if (um) um.forEach(u => urls.add(u));
            });
            return [...urls];
        });

        collected.push({ source: 'dom', urls: pageUrls });
    } catch (err) {
        collected.push({ source: 'error', msg: err.message });
    } finally {
        await page.close();
    }

    let result = null;
    const fh = (() => { try { return new URL(finalUrl).host; } catch(e) { return ''; } })();

    if (finalUrl !== rawUrl && !isShortenerDomain(fh)) {
        result = finalUrl;
    }

    if (!result) {
        const candidates = [
            ...collected.filter(c => c.source === '3xx').map(c => c.url),
            ...collected.filter(c => c.source === 'request').map(c => c.url),
            ...(collected.find(c => c.source === 'dom')?.urls || []),
        ];
        for (const c of candidates) {
            try {
                const u = new URL(c);
                if (!isShortenerDomain(u.host) && u.protocol === 'https:' &&
                    !u.host.includes('google') && !u.host.includes('doubleclick')) {
                    result = c;
                    break;
                }
            } catch (e) {}
        }
    }

    return { original: rawUrl, final_url: finalUrl, bypassed: result, method: result ? 'headless_browser' : null };
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const parsed = new URL(req.url, `http://${req.headers.host}`);
    if (parsed.pathname !== '/bypass') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Use /bypass?url=' }));
    }

    const targetUrl = parsed.searchParams.get('url');
    if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing ?url=' }));
    }

    let nUrl = targetUrl;
    if (!/^https?:\/\//i.test(nUrl)) nUrl = 'https://' + nUrl;

    console.log('[+] ' + nUrl);
    try {
        const r = await bypassPage(nUrl);
        console.log('[+] -> ' + (r.bypassed || 'no result'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r, null, 2));
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log('[+] Running on http://127.0.0.1:' + PORT + '/bypass?url=');
});