const http = require('http');
const puppeteer = require('puppeteer');
const { URL } = require('url');

const PORT = process.env.PORT || 10000;
const TIMEOUT = 30000;

let browser = null;

async function getBrowser() {
    if (!browser || !browser.isConnected()) {
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--single-process',
                '--no-zygote',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-sync',
                '--disable-translate',
                '--mute-audio',
                '--no-first-run',
                '--disable-ipc-flooding-protection',
                '--disable-renderer-backgrounding',
                '--disable-backgrounding-occluded-windows',
                '--force-color-profile=srgb',
            ],
        });
    }
    return browser;
}

function isShortenerDomain(host) {
    const h = host.toLowerCase();
    const list = [
        'gplinks', 'gp-links', 'gplink', 'gplink.co', 'gplinks.co', 'gplinks.in',
        'linkvertise', 'link-to', 'link-center', 'direct-link',
        'ouo.io', 'ouo.press', 'ouo.today',
        'adfly', 'adf.ly', 'j.gs', 'q.gs',
        'shrinkme.io', 'shrtfly.com', 'shortino', 'earnlink', 'illink', 'linksly',
        'rocklinks', 'urlpay', 'try2link', 'cety.app', 'mdisk', 'psa.wf', 'tnlink', 'cblink',
        'linkshortener', 'krownlinks', 'roneox', 'megaurl', 'exe.io', 'exey.io',
    ];
    return list.some(x => h.includes(x));
}

// Tracking param cleanup
function cleanUrl(url) {
    try {
        const u = new URL(url);
        const strip = [
            'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
            'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid', 'twclid', 'ttclid', 'li_fat_id',
            'ref', 'ref_src', 'ref_url', 'source', 'si', 'feature',
            'mc_cid', 'mc_eid', 'sb_source', 'sb_type', 'igshid', 'wplayer', 'yclid',
            '_ga', '_gl', '_hsenc', '_hsmi', 'hsCtaTracking',
            'vero_id', 'oly_anon_id', 'oly_enc_id', '_openstat',
            'wickedid', 'spm', 'scm',
        ];
        strip.forEach(p => u.searchParams.delete(p));
        return u.toString();
    } catch (e) {
        return url;
    }
}

// HTTP redirect expander (for non-JS shorteners)
async function expandCurl(rawUrl) {
    const chain = [];
    const seen = new Set();
    let current = rawUrl;
    let code = 0;

    for (let i = 0; i < 15; i++) {
        if (seen.has(current)) break;
        seen.add(current);

        const urlObj = new URL(current);
        const result = await new Promise((resolve) => {
            const mod = urlObj.protocol === 'https:' ? require('https') : require('http');
            const req = mod.request(current, { method: 'HEAD', timeout: 10000 }, (res) => {
                resolve({ code: res.statusCode, location: res.headers.location });
            });
            req.on('timeout', () => { req.destroy(); resolve({ code: 0, location: null }); });
            req.on('error', () => resolve({ code: 0, location: null }));
            req.end();
        });

        code = result.code;
        chain.push({ url: current, code });

        if (code >= 300 && code < 400 && result.location) {
            const loc = result.location.startsWith('http') ? result.location : new URL(result.location, current).href;
            current = loc;
            continue;
        }
        break;
    }

    return { final: current, code, chain };
}

async function bypassPage(rawUrl) {
    const page = await (await getBrowser()).newPage();

    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const t = req.resourceType();
        if (['image', 'font', 'stylesheet', 'media'].includes(t)) {
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
                '#btn-main', '#btn2', '#btn1', '#proceed',
                'button.btn-main', 'button.get-link', 'button.redirect',
                'input[type="submit"]', '.btn-primary', '#submit',
                'a[href*="redirect"]', 'a.btn', 'button:not([disabled])',
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
                try { urls.add(new URL(a.href, location.origin).href); } catch (e) {}
            });
            document.querySelectorAll('meta[http-equiv="refresh"]').forEach(m => {
                const c = m.getAttribute('content') || '';
                const m2 = c.match(/url=(.+)/i);
                if (m2) try { urls.add(new URL(m2[1], location.origin).href); } catch (e) {}
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
    let fh = '';
    try { fh = new URL(finalUrl).host; } catch (e) {}

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

async function processBypass(rawUrl) {
    let url = rawUrl.trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    const logs = [];
    logs.push(`[info] Input: ${url}`);

    let bypassed = null;
    let method = null;
    let chain = [];

    if (isShortenerDomain(new URL(url).host)) {
        logs.push('[info] Routing to headless browser');
        try {
            const r = await bypassPage(url);
            bypassed = r.bypassed;
            method = r.method;
            logs.push(`[info] Browser final: ${r.final_url}`);
            logs.push(`[info] Browser bypassed: ${r.bypassed || 'none'}`);
        } catch (e) {
            logs.push(`[error] Browser failed: ${e.message}`);
        }
    }

    if (!bypassed) {
        logs.push('[info] Falling back to HTTP redirect expansion');
        try {
            const r = await expandCurl(url);
            chain = r.chain;
            if (r.final !== url) {
                bypassed = r.final;
                method = 'redirect_expansion';
                logs.push(`[info] Curl resolved to: ${r.final}`);
            }
        } catch (e) {
            logs.push(`[error] Curl failed: ${e.message}`);
        }
    }

    const cleaned = cleanUrl(bypassed || url);
    if (cleaned !== (bypassed || url)) {
        logs.push('[info] Tracking params stripped');
    }

    return {
        original: url,
        bypassed,
        cleaned,
        method,
        chain,
        logs,
    };
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link Bypasser</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0a0a0a;color:#d4d4d4;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:40px 16px}
h1{font-size:24px;font-weight:600;margin-bottom:4px;background:linear-gradient(135deg,#667eea,#764ba2);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.sub{color:#555;font-size:13px;margin-bottom:32px}
.box{width:100%;max-width:680px}
.bar{display:flex;gap:10px;margin-bottom:24px}
.bar input{flex:1;padding:12px 14px;background:#131313;border:1px solid #252525;border-radius:10px;color:#fff;font-size:14px;outline:none;transition:border-color .2s}
.bar input:focus{border-color:#667eea}
.bar input::placeholder{color:#444}
.bar button{padding:12px 22px;background:linear-gradient(135deg,#667eea,#764ba2);border:none;border-radius:10px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap;transition:opacity .2s}
.bar button:hover{opacity:.9}
.bar button:disabled{opacity:.4;cursor:not-allowed}
.msg{padding:10px 12px;border-radius:8px;font-size:13px;margin-bottom:12px}
.msg.err{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#f87171}
.msg.ok{background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);color:#4ade80}
.msg.warn{background:rgba(234,179,8,.1);border:1px solid rgba(234,179,8,.3);color:#facc15}
.card{background:#111;border:1px solid #222;border-radius:10px;padding:16px;margin-bottom:12px}
.card .lbl{font-size:11px;color:#555;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px}
.card .val{font-size:13px;color:#bbb;word-break:break-all;line-height:1.6}
.card .val a{color:#667eea;text-decoration:none}
.card .val a:hover{text-decoration:underline}
.badge{display:inline-block;padding:3px 10px;border-radius:16px;font-size:11px;background:rgba(102,126,234,.12);color:#818cf8;margin-bottom:12px}
.copy{background:#161616;border:1px solid #252525;color:#777;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer;margin-top:6px;transition:border-color .2s,color .2s}
.copy:hover{border-color:#667eea;color:#667eea}
.loading{text-align:center;padding:30px;color:#555}
.spin{width:32px;height:32px;border:3px solid #252525;border-top-color:#667eea;border-radius:50%;animation:s .7s linear infinite;margin:0 auto 12px}
@keyframes s{to{transform:rotate(360deg)}}
.cs{display:flex;gap:8px;align-items:baseline;font-size:12px;margin-bottom:5px}
.cs .c{min-width:32px;text-align:right;font-variant-numeric:tabular-nums;color:#6b7280}
.cs .u{color:#9ca3af;word-break:break-all}
details.lb{margin-top:16px}
details.lb summary{cursor:pointer;color:#555;font-size:12px;margin-bottom:6px}
details.lb pre{background:#0d0d0d;border:1px solid #1a1a1a;border-radius:8px;padding:12px;font-size:11px;line-height:1.6;color:#555;max-height:240px;overflow:auto;white-space:pre-wrap}
.api{margin-top:36px;background:#111;border:1px solid #222;border-radius:10px;padding:18px}
.api h3{font-size:13px;color:#666;margin-bottom:12px}
.api code{display:block;background:#0a0a0a;padding:12px;border-radius:8px;font-family:'Fira Code',monospace;font-size:12px;color:#818cf8;overflow-x:auto;margin-bottom:8px;white-space:pre}
.api p{color:#444;font-size:12px}
.tags{margin-top:30px;text-align:center}
.tags h3{color:#444;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}
.tags .w{display:flex;flex-wrap:wrap;gap:6px;justify-content:center}
.tags span{background:#131313;border:1px solid #1b1b1b;padding:4px 10px;border-radius:16px;font-size:11px;color:#4b5563}
</style>
</head>
<body>
<h1>Link Bypasser</h1>
<p class="sub">Expands shortened URLs with headless browser.</p>
<div class="box">
<div class="bar">
<input type="text" id="urlIn" placeholder="https://gplinks.co/xxx or any short link">
<button id="goBtn" onclick="doBypass()">Bypass</button>
</div>
<div id="out"></div>
<div class="api">
<h3>API</h3>
<code>GET /bypass?url=https://gplinks.co/xxx</code>
<p>Returns JSON: original, bypassed, cleaned, method, chain, logs</p>
</div>
<div class="tags">
<h3>Works with</h3>
<div class="w">
<span>GP Links</span><span>Linkvertise</span><span>Ouo</span><span>ShrinkMe</span>
<span>bit.ly</span><span>t.co</span><span>tinyurl</span><span>cutt.ly</span>
<span>rb.gy</span><span>Any 3xx shortener</span><span>Tracking cleanup</span>
</div>
</div>
</div>
<script>
async function doBypass(){
const url=document.getElementById('urlIn').value.trim();
const out=document.getElementById('out');
const btn=document.getElementById('goBtn');
if(!url){out.innerHTML='<div class="msg err">Enter a URL</div>';return}
let u=url;if(!/^(https?:)\\/\\//i.test(u))u='https://'+u;
btn.disabled=true;
out.innerHTML='<div class="loading"><div class="spin"></div>Bypassing...</div>';
try{
const r=await fetch('/bypass?url='+encodeURIComponent(u));
const d=await r.json();
if(d.bypassed){
let chainHtml='';
if(d.chain&&d.chain.length>1){
chainHtml='<div class="card"><div class="lbl">Redirect chain</div>';
d.chain.forEach(s=>{chainHtml+='<div class="cs"><span class="c">'+s.code+'</span><span class="u">'+esc(s.url)+'</span></div>'});
chainHtml+='</div>';
}
let logHtml='';
if(d.logs&&d.logs.length){
logHtml='<details class="lb"><summary>Logs</summary><pre>'+d.logs.map(esc).join('\\n')+'</pre></details>';
}
let cleanHtml='';
if(d.cleaned&&d.cleaned!==d.bypassed){
cleanHtml='<div class="card"><div class="lbl">Cleaned URL</div><div class="val"><a href="'+esc(d.cleaned)+'" target="_blank">'+esc(d.cleaned)+'</a></div><button class="copy" onclick="cp(this,\\''+esc(d.cleaned).replace(/'/g,"\\\\'")+'\\')">Copy</button></div>';
}
out.innerHTML='<div class="badge">'+esc(d.method||'bypassed')+'</div>'
+'<div class="card"><div class="lbl">Original</div><div class="val">'+esc(d.original)+'</div></div>'
+'<div class="card"><div class="lbl">Bypassed</div><div class="val"><a href="'+esc(d.bypassed)+'" target="_blank">'+esc(d.bypassed)+'</a></div><button class="copy" onclick="cp(this,\\''+esc(d.bypassed).replace(/'/g,"\\\\'")+'\\')">Copy</button></div>'
+cleanHtml+chainHtml+logHtml;
}else{
let logHtml='';
if(d.logs)logHtml='<details class="lb"><summary>Logs</summary><pre>'+d.logs.map(esc).join('\\n')+'</pre></details>';
out.innerHTML='<div class="msg warn">Could not bypass this link.</div>'+logHtml;
if(d.error)out.innerHTML+='<div class="msg err">'+esc(d.error)+'</div>';
}
}catch(e){
out.innerHTML='<div class="msg err">Error: '+esc(e.message)+'</div>';
}
btn.disabled=false;
}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function cp(b,t){navigator.clipboard.writeText(t).then(()=>{b.textContent='Copied!';setTimeout(()=>b.textContent='Copy',2000)})}
document.getElementById('urlIn').addEventListener('keydown',e=>{if(e.key==='Enter')doBypass()});
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const parsed = new URL(req.url, `http://${req.headers.host}`);

    if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(HTML);
    }

    if (parsed.pathname === '/bypass') {
        const targetUrl = parsed.searchParams.get('url');
        if (!targetUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Missing ?url=' }));
        }

        let nUrl = targetUrl;
        if (!/^https?:\/\//i.test(nUrl)) nUrl = 'https://' + nUrl;

        try {
            new URL(nUrl);
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Invalid URL' }));
        }

        console.log(`[+] ${nUrl}`);
        try {
            const result = await processBypass(nUrl);
            console.log(`[+] -> ${result.bypassed || 'no result'}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result, null, 2));
        } catch (err) {
            console.error(`[-] ${err.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[+] Running on port ${PORT}`);
});