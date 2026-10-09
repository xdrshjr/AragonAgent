// Scratch helper: extract result links from a DuckDuckGo HTML page.
const fs = require('fs');
const file = process.argv[2];
const html = fs.readFileSync(file, 'utf8');
const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
let m;
let i = 0;
while ((m = re.exec(html)) && i < 15) {
  const title = m[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'");
  let url = m[1];
  const ddg = url.match(/uddg=([^&]+)/);
  if (ddg) url = decodeURIComponent(ddg[1]);
  console.log(`${++i}. ${title}\n   ${url}`);
}
