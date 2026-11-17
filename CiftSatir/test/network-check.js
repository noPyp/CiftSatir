// Hits the real dictionary and translation endpoints the extension depends on.
//
// The extension shows "Anlam bulunamadı" when every free provider fails, which
// happens both when the service worker is dead and when an upstream API has
// moved, changed shape or started rate-limiting. This separates those cases.
//
//   node test/network-check.js
//
// Requires network access; it is not part of the offline test suites.

const https = require('https');

function get(url) {
  return new Promise((resolve) => {
    const request = https.get(url, {
      headers: { 'user-agent': 'CiftSatir-check/1.0', accept: 'application/json' }
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode,
        contentType: response.headers['content-type'] || '',
        body: body
      }));
    });

    request.on('error', (error) => resolve({ status: 0, error: error.message, body: '' }));
    request.setTimeout(10000, () => {
      request.destroy();
      resolve({ status: 0, error: 'timeout', body: '' });
    });
  });
}

(async () => {
  // The dictionary API is treated as degraded rather than failing: it has been
  // hanging since 2026-10-15, and the extension is built to work without it
  // (Wiktionary covers the English side, at the cost of IPA). This script
  // reports its state instead of failing the run over it.
  let degraded = 0;
  let broken = 0;

  // ---- Free Dictionary API (optional: supplies IPA) ----
  console.log('== Free Dictionary API (IPA source) ==');
  const dict = await get('https://api.dictionaryapi.dev/api/v2/entries/en/understand');
  console.log('   status: ' + dict.status + (dict.error ? ' (' + dict.error + ')' : ''));

  if (dict.status === 200) {
    try {
      const data = JSON.parse(dict.body);
      const entry = Array.isArray(data) ? data[0] : null;
      const ipa = entry && (entry.phonetics || []).find((p) => p && p.text);
      const pos = entry && entry.meanings && entry.meanings[0] && entry.meanings[0].partOfSpeech;
      console.log('   partOfSpeech: ' + pos);
      console.log('   ipa: ' + (ipa ? ipa.text : '(none)'));
      if (!pos || !ipa) {
        degraded += 1;
        console.log('   ! reachable but the fields the code reads are missing');
      }
    } catch (error) {
      broken += 1;
      console.log('   ! response is not the expected JSON: ' + error.message);
    }
  } else {
    degraded += 1;
    console.log('   unavailable - IPA will be blank; Wiktionary takes over the');
    console.log('   part of speech. Not fatal: the chain is built for this.');
  }

  // ---- Wiktionary (the English-side fallback; must work) ----
  console.log('');
  console.log('== Wiktionary (English fallback) ==');
  const wikt = await get('https://en.wiktionary.org/api/rest_v1/page/definition/understand');
  console.log('   status: ' + wikt.status + (wikt.error ? ' (' + wikt.error + ')' : ''));

  if (wikt.status === 200) {
    try {
      const data = JSON.parse(wikt.body);
      const entry = data && Array.isArray(data.en) ? data.en[0] : null;
      const pos = entry && entry.partOfSpeech;
      const def = entry && entry.definitions && entry.definitions[0];
      console.log('   partOfSpeech: ' + pos);
      console.log('   definition: ' + (def ? String(def.definition).slice(0, 90) + '…' : '(none)'));
      if (!pos || !def) {
        broken += 1;
        console.log('   ! no usable entry - the English side has no source left');
      }
    } catch (error) {
      broken += 1;
      console.log('   ! response is not the expected JSON: ' + error.message);
    }
  } else {
    broken += 1;
    console.log('   ! unreachable - this is the fallback the chain depends on');
  }

  // ---- MyMemory (must work: it is the only Turkish meaning source) ----
  console.log('');
  console.log('== MyMemory translation ==');
  const mm = await get('https://api.mymemory.translated.net/get?q=understand&langpair=en%7Ctr');
  console.log('   status: ' + mm.status + (mm.error ? ' (' + mm.error + ')' : ''));

  if (mm.status === 200) {
    try {
      const data = JSON.parse(mm.body);
      const translated = data && data.responseData && data.responseData.translatedText;
      console.log('   translatedText: ' + JSON.stringify(translated));
      if (!translated) {
        broken += 1;
        console.log('   ! no responseData.translatedText - the shape changed');
      }
    } catch (error) {
      broken += 1;
      console.log('   ! response is not the expected JSON: ' + error.message);
    }
  } else {
    broken += 1;
    console.log('   ! unreachable - no Turkish meanings would come back at all');
  }

  // ---- Anthropic reachability (no key, so 401/405 is the healthy answer) ----
  console.log('');
  console.log('== Claude API reachability ==');
  const anthropic = await get('https://api.anthropic.com/v1/messages');
  console.log('   status: ' + (anthropic.status || anthropic.error || '?'));
  if ([400, 401, 405].includes(anthropic.status)) {
    console.log('   reachable (auth-required response, as expected without a key)');
  } else {
    console.log('   note: expected 400/401/405 without a key');
  }

  console.log('');
  if (broken) {
    console.log(broken + ' provider(s) broken - the lookup chain has no working source.');
    process.exit(1);
  }

  console.log('The lookup chain has every source it needs.');
  if (degraded) {
    console.log('(' + degraded + ' degraded, non-fatal: see above.)');
  }
})().catch((error) => {
  console.log('THREW: ' + (error && error.stack ? error.stack : error));
  process.exit(1);
});
