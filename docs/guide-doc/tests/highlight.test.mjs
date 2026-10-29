/**
 * 保护什么：自研高亮的 4 种语言 token 分类、未知语言退化，以及「先转义再包裹」这条不可协商的纪律。
 *
 * 为什么需要它：高亮是唯一一处「把源码原样搬进 HTML」的地方。顺序一写反，
 * 代码里的 `</pre><script>` 就从文字变成标签 —— 这是本站唯一的真 XSS 入口。
 * 而它还不会让构建失败：页面照常渲染，只是被打穿。所以顺序必须被断言钉死。
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { highlight, isKnownLang, normalizeLang } from '../src/render/highlight.mjs';

test('ts：关键字 / 字符串 / 数字 / 注释 / 函数名各有自己的 token 类', () => {
  const ts = highlight('const n = 42;', 'ts');
  assert.equal(ts.lang, 'ts');
  assert.equal(ts.degraded, false);
  assert.match(ts.html, /<span class="tok-key">const<\/span>/);
  assert.match(ts.html, /<span class="tok-num">42<\/span>/);

  assert.match(highlight("const s = 'hi';", 'ts').html, /<span class="tok-str">&#39;hi&#39;<\/span>/);
  assert.match(highlight('// 注释', 'ts').html, /<span class="tok-com">\/\/ 注释<\/span>/);
  assert.match(highlight('run(1)', 'ts').html, /<span class="tok-fn">run<\/span>/);
});

test('ts 别名（js / tsx / mjs）归一到同一条词法', () => {
  for (const alias of ['ts', 'tsx', 'js', 'jsx', 'mjs', 'typescript', 'JAVASCRIPT']) {
    assert.equal(normalizeLang(alias), 'ts', `${alias} 未归一为 ts`);
    assert.equal(highlight('const a = 1;', alias).lang, 'ts');
  }
});

test('json：键名是 tok-attr，字面量是 tok-key', () => {
  const json = highlight('{"phase": "all", "dry": true, "n": null}', 'json');
  assert.equal(json.lang, 'json');
  assert.match(json.html, /<span class="tok-attr">&quot;phase&quot;<\/span>/);
  assert.match(json.html, /<span class="tok-str">&quot;all&quot;<\/span>/);
  assert.match(json.html, /<span class="tok-key">true<\/span>/);
  assert.match(json.html, /<span class="tok-key">null<\/span>/);
});

test('bash：flag 单独着色，注释不会被当成 flag', () => {
  const bash = highlight('aragon --phase all --dry-run', 'bash');
  assert.equal(bash.lang, 'bash');
  assert.match(bash.html, /<span class="tok-flag">--phase<\/span>/);
  assert.match(bash.html, /<span class="tok-flag">--dry-run<\/span>/);
  // flag 之后的普通参数保持原样（不被吞进 token）。
  assert.match(bash.html, /<\/span> all /);

  const commented = highlight('# 只是注释', 'bash');
  assert.match(commented.html, /<span class="tok-com"># 只是注释<\/span>/);
  assert.equal(commented.html.includes('tok-flag'), false);
});

test('text：整段原样输出，不产出任何 token span', () => {
  const text = highlight('exit code 0', 'text');
  assert.equal(text.lang, 'text');
  assert.equal(text.degraded, false);
  // `out` 类 token 不包裹：纯输出不该被伪造成高亮。注意 `components.css` 里
  // `.tok-out` 这条规则目前是死代码（渲染层永不产出该类），断言用「无 span」钉住现实。
  assert.equal(text.html, 'exit code 0');
  assert.equal(text.html.includes('<span'), false);
});

test('转义发生在包裹之前：</pre><script> 只能变成文字', () => {
  const result = highlight("const x = '</pre><script>';", 'ts');
  assert.match(result.html, /&lt;\/pre&gt;/);
  assert.match(result.html, /&lt;script&gt;/);
  // 关键字与类名之外，不出现任何真标签。
  assert.equal(result.html.includes('<script'), false);
  assert.equal(result.html.includes('</pre>'), false);
});

test('text 与 bash 的输出来路同样先转义', () => {
  const text = highlight('<img src=x onerror=alert(1)>', 'text');
  assert.equal(text.html.includes('<img'), false);
  assert.match(text.html, /&lt;img/);
  const bash = highlight('echo "<b>"', 'bash');
  assert.equal(bash.html.includes('<b>'), false);
  assert.match(bash.html, /&lt;b&gt;/);
});

test('未知语言退化：degraded 为真，且不产出任何 token 包裹', () => {
  const result = highlight('fn main() {}', 'rust');
  assert.equal(result.degraded, true);
  assert.equal(result.lang, 'text');
  assert.equal(result.html.includes('tok-'), false);
  assert.match(result.html, /fn main\(\) \{\}/);
});

test('空输入是安全的（不会产出空 span，也不抛错）', () => {
  for (const lang of ['ts', 'json', 'bash', 'text', 'rust']) {
    const result = highlight('', lang);
    assert.equal(result.html, '');
  }
  assert.equal(highlight(null, 'ts').html, '');
  assert.equal(highlight(undefined).html, '');
});

test('去掉唯一的行尾换行与 CRLF，避免代码块尾部多一行空白', () => {
  assert.equal(highlight('a\r\nb', 'text').html, 'a\nb');
  assert.equal(highlight('abc\n', 'text').html, 'abc');
  // 只吃掉**一个**尾换行：多出来的空行是作者有意留的。
  assert.equal(highlight('abc\n\n', 'text').html, 'abc\n');
  assert.equal(highlight('a\r\nb', 'ts').html.includes('\r'), false);
});

test('isKnownLang / normalizeLang 的口径', () => {
  for (const known of ['ts', 'json', 'bash', 'text', '', 'console', 'shell-session', 'jsonc', 'txt']) {
    assert.equal(isKnownLang(known), true, `${known} 应被识别`);
  }
  for (const unknown of ['rust', 'go', 'python', 'mermaid', 'cobol']) {
    assert.equal(isKnownLang(unknown), false, `${unknown} 不该被识别`);
  }
  assert.equal(isKnownLang(' TS '), true);
  assert.equal(isKnownLang(null), true);
  assert.equal(isKnownLang(undefined), true);

  // `console` 是输出而不是命令：按 bash 高亮会把 `# 注释` 当注释、`--flag` 当参数，
  // 而 §6.4 规定输出整体落在 --c-out（text）。
  assert.equal(normalizeLang('console'), 'text');
  assert.equal(normalizeLang('jsonc'), 'json');
  assert.equal(normalizeLang('plaintext'), 'text');
  assert.equal(normalizeLang(''), 'text');
  assert.equal(normalizeLang('rust'), 'text');
  assert.equal(normalizeLang(undefined), 'text');
});
