(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});
  const { PANEL_CLASS } = DS.constants;

  // The word panel. It mirrors the learning site's word analysis card:
  // word + part of speech + IPA, Turkish meaning(s), the real subtitle line the
  // word came from, American/British pronunciation, starring, and five example
  // sentences with translations.

  function speak(text, lang) {
    const phrase = String(text || '').trim();
    if (!global.speechSynthesis || !phrase) {
      return false;
    }

    try {
      global.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(phrase);
      utterance.lang = lang === 'en-GB' ? 'en-GB' : 'en-US';
      utterance.rate = 0.9;
      utterance.pitch = 1;

      // Prefer an installed voice for the requested accent, when one exists.
      const voices = global.speechSynthesis.getVoices ? global.speechSynthesis.getVoices() : [];
      const match = voices.find((voice) => voice && voice.lang === utterance.lang) ||
        voices.find((voice) => voice && String(voice.lang || '').toLowerCase().indexOf(
          utterance.lang.slice(0, 2)) === 0);
      if (match) {
        utterance.voice = match;
      }

      global.speechSynthesis.speak(utterance);
      return true;
    } catch (error) {
      return false;
    }
  }

  function createPanel() {
    const panel = document.createElement('div');
    panel.className = PANEL_CLASS + ' is-hidden';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Kelime anlamı');

    panel.innerHTML = [
      '<div class="dualsub-panel-head">',
      '  <div class="dualsub-panel-title">',
      '    <span class="dualsub-panel-word"></span>',
      '    <span class="dualsub-panel-ipa"></span>',
      '  </div>',
      '  <div class="dualsub-panel-actions">',
      '    <button type="button" class="dualsub-panel-btn dualsub-us-btn" title="Amerikan telaffuzu" aria-label="Amerikan telaffuzu">US</button>',
      '    <button type="button" class="dualsub-panel-btn dualsub-uk-btn" title="İngiliz telaffuzu" aria-label="İngiliz telaffuzu">UK</button>',
      '    <button type="button" class="dualsub-panel-btn dualsub-star-btn" title="Kelimeyi kütüphaneye kaydet" aria-pressed="false">☆</button>',
      '    <button type="button" class="dualsub-panel-btn dualsub-close-btn" title="Kapat" aria-label="Kapat">×</button>',
      '  </div>',
      '</div>',
      '<div class="dualsub-panel-meaning is-loading">Anlam yükleniyor…</div>',
      '<div class="dualsub-panel-meta">',
      '  <span class="dualsub-panel-pos"></span>',
      '  <span class="dualsub-panel-source"></span>',
      '</div>',
      '<div class="dualsub-panel-context is-hidden">',
      '  <div class="dualsub-panel-context-label">Geçtiği cümle</div>',
      '  <div class="dualsub-panel-context-en"></div>',
      '  <div class="dualsub-panel-context-tr"></div>',
      '</div>',
      '<div class="dualsub-panel-sentences">',
      '  <div class="dualsub-panel-sentences-head">',
      '    <span>5 örnek cümle</span>',
      '    <button type="button" class="dualsub-panel-btn dualsub-refresh-btn" title="Yeni cümleler getir">↻ Yeni</button>',
      '  </div>',
      '  <div class="dualsub-panel-sentences-body"></div>',
      '</div>',
      '<div class="dualsub-panel-foot">',
      '  <button type="button" class="dualsub-panel-btn dualsub-play-btn">▶ Videoyu sürdür</button>',
      '</div>'
    ].join('');

    const find = (selector) => panel.querySelector(selector);

    return {
      el: panel,
      wordEl: find('.dualsub-panel-word'),
      ipaEl: find('.dualsub-panel-ipa'),
      meaningEl: find('.dualsub-panel-meaning'),
      posEl: find('.dualsub-panel-pos'),
      sourceEl: find('.dualsub-panel-source'),
      contextEl: find('.dualsub-panel-context'),
      contextEn: find('.dualsub-panel-context-en'),
      contextTr: find('.dualsub-panel-context-tr'),
      sentencesEl: find('.dualsub-panel-sentences'),
      sentencesBody: find('.dualsub-panel-sentences-body'),
      sentencesBtn: find('.dualsub-refresh-btn'),
      starBtn: find('.dualsub-star-btn'),
      usBtn: find('.dualsub-us-btn'),
      ukBtn: find('.dualsub-uk-btn'),
      playBtn: find('.dualsub-play-btn'),
      closeBtn: find('.dualsub-close-btn')
    };
  }

  function renderSentences(container, sentences, customMessage) {
    container.textContent = '';

    if (!Array.isArray(sentences) || !sentences.length) {
      const empty = document.createElement('div');
      empty.className = 'dualsub-sentence-empty';
      empty.textContent = customMessage || 'Cümle bulunamadı.';
      container.appendChild(empty);
      return;
    }

    const list = document.createElement('ol');
    list.className = 'dualsub-sentence-list';

    for (const sentence of sentences) {
      const item = document.createElement('li');
      item.className = 'dualsub-sentence';

      const en = document.createElement('div');
      en.className = 'dualsub-sentence-en';
      en.textContent = sentence.en || '';

      const tr = document.createElement('div');
      tr.className = 'dualsub-sentence-tr';
      tr.textContent = sentence.tr || '';

      item.appendChild(en);
      item.appendChild(tr);

      if (sentence.level) {
        const level = document.createElement('span');
        level.className = 'dualsub-sentence-level';
        level.textContent = sentence.level;
        item.appendChild(level);
      }

      list.appendChild(item);
    }

    if (sentences.length < 5) {
      const note = document.createElement('div');
      note.className = 'dualsub-sentence-note';
      note.textContent = 'Yalnızca ' + sentences.length + ' cümle doğrulanabildi.';
      list.appendChild(note);
    }

    container.appendChild(list);
  }

  function attachPanel(panel, handlers) {
    const state = {
      word: null,
      starred: false,
      sentences: [],
      sentencesLoaded: false,
      sentencesToken: 0,
      lookupToken: 0,
      source: null,
      aiDone: false
    };

    function setStarred(isStarred) {
      state.starred = Boolean(isStarred);
      panel.starBtn.textContent = state.starred ? '★' : '☆';
      panel.starBtn.classList.toggle('is-starred', state.starred);
      panel.starBtn.setAttribute('aria-pressed', String(state.starred));
    }

    function setSentencesLoading(message) {
      panel.sentencesBody.textContent = '';
      const loading = document.createElement('div');
      loading.className = 'dualsub-sentence-loading';
      loading.textContent = message || 'Örnek cümleler hazırlanıyor…';
      panel.sentencesBody.appendChild(loading);
    }

    function showSentenceFailure(message, canRetry) {
      panel.sentencesBody.textContent = '';
      const box = document.createElement('div');
      box.className = 'dualsub-sentence-error';
      box.textContent = message;
      panel.sentencesBody.appendChild(box);

      if (canRetry) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'dualsub-panel-btn dualsub-retry-btn';
        retry.textContent = 'Tekrar dene';
        retry.addEventListener('click', () => loadSentences());
        panel.sentencesBody.appendChild(retry);
      }
    }

    function loadSentences() {
      const word = state.word;
      if (!word) {
        return;
      }

      const token = ++state.sentencesToken;
      panel.sentencesBtn.disabled = true;
      setSentencesLoading();

      Promise.resolve(handlers.sentences
        ? handlers.sentences(word, state.source && state.source.sentence)
        : null)
        .then((response) => {
          if (token !== state.sentencesToken || state.word !== word) {
            return;
          }

          const sentences = Array.isArray(response) ? response : (response && response.sentences);
          const warning = (response && response.warning) || '';
          const reason = (response && response.error) || '';
          const transport = DS.messaging.getLastError && DS.messaging.getLastError();

          if (Array.isArray(sentences) && sentences.length) {
            state.sentences = sentences;
            state.sentencesLoaded = true;
            renderSentences(panel.sentencesBody, sentences);
            panel.sentencesBtn.textContent = '↻ Yeni';

            if (warning) {
              const note = document.createElement('div');
              note.className = 'dualsub-sentence-note';
              note.textContent = warning;
              panel.sentencesBody.appendChild(note);
            }
            position();
            return;
          }

          state.sentences = [];
          state.sentencesLoaded = false;

          const message = transport
            ? 'Arka plan servisine ulaşılamadı: ' + transport
            : (warning || reason || 'Örnek cümleler şu an alınamadı. Ücretsiz kaynaklar yanıt vermiyor olabilir.');
          showSentenceFailure(message, true);
          position();
        })
        .catch((error) => {
          if (token !== state.sentencesToken || state.word !== word) {
            return;
          }
          showSentenceFailure(
            String(error && error.message ? error.message : error),
            true
          );
        })
        .then(() => {
          if (token === state.sentencesToken) {
            panel.sentencesBtn.disabled = false;
          }
        });
    }

    function show(word, anchorRect, source) {
      state.word = word;
      state.sentences = [];
      state.sentencesLoaded = false;
      state.sentencesToken += 1;
      state.source = source || null;
      state.aiDone = false;
      const lookupToken = ++state.lookupToken;

      panel.wordEl.textContent = word;
      panel.ipaEl.textContent = '';
      panel.meaningEl.textContent = 'Anlam yükleniyor…';
      panel.meaningEl.className = 'dualsub-panel-meaning is-loading';
      panel.posEl.textContent = '';
      panel.sourceEl.textContent = '';
      setStarred(false);

      if (source && source.sentence) {
        panel.contextEl.classList.remove('is-hidden');
        panel.contextEn.textContent = source.sentence;
        panel.contextTr.textContent = source.trSentence || '';
        panel.contextTr.classList.toggle('is-hidden', !source.trSentence);
      } else {
        panel.contextEl.classList.add('is-hidden');
      }

      panel.el.classList.remove('is-hidden');
      setSentencesLoading();
      position(anchorRect);

      Promise.resolve()
        .then(() => (handlers.lookup ? handlers.lookup(word, source && source.sentence) : null))
        .then((result) => {
          if (lookupToken !== state.lookupToken || state.word !== word) {
            return;
          }

          if (result && !result.error) {
            const meanings = (result.meanings || []).filter(Boolean);
            panel.meaningEl.textContent = meanings.length
              ? meanings.join(' · ')
              : 'Anlam bulunamadı.';
            panel.meaningEl.className = 'dualsub-panel-meaning' +
              (meanings.length ? '' : ' is-empty');
            panel.posEl.textContent = result.partOfSpeech || '';
            panel.ipaEl.textContent = result.ipa || '';
            panel.sourceEl.textContent = result.matchedForm
              ? '(' + result.matchedForm + ' kökünden)'
              : '';
            return;
          }

          const failure = DS.messaging.getLastError && DS.messaging.getLastError();
          panel.meaningEl.textContent = failure
            ? 'Sözlüğe ulaşılamadı.'
            : 'Anlam bulunamadı.';
          panel.meaningEl.className = 'dualsub-panel-meaning is-empty';
          panel.posEl.textContent = failure || '';
        })
        .catch((error) => {
          if (lookupToken !== state.lookupToken || state.word !== word) {
            return;
          }
          panel.meaningEl.textContent = 'Anlam alınamadı.';
          panel.meaningEl.className = 'dualsub-panel-meaning is-empty';
          panel.posEl.textContent = String(error && error.message ? error.message : error);
        });

      // Context-aware meanings arrive after the fast lookup and upgrade the
      // card in place. This is the same two-stage pattern the learning site
      // uses, so a slow free AI never blocks the first answer.
      if (source && source.sentence && handlers.refine) {
        Promise.resolve(handlers.refine(word, source.sentence))
          .then((refined) => {
            if (!refined || lookupToken !== state.lookupToken || state.word !== word ||
              state.aiDone) {
              return;
            }
            if (Array.isArray(refined.meanings) && refined.meanings.length) {
              state.aiDone = true;
              panel.meaningEl.textContent = refined.meanings.join(' · ');
              panel.meaningEl.className = 'dualsub-panel-meaning';
              if (refined.partOfSpeech && !panel.posEl.textContent) {
                panel.posEl.textContent = refined.partOfSpeech;
              }
              panel.sourceEl.textContent = 'bağlama göre';
            }
          })
          .catch(() => {});
      }

      if (handlers.isStarred) {
        Promise.resolve(handlers.isStarred(word))
          .then((isStarred) => {
            if (state.word === word) {
              setStarred(isStarred);
            }
          })
          .catch(() => {});
      }

      // Five sentences load immediately: they are the main learning content of
      // this panel. The worker rotates them, so reopening a word shows new ones.
      loadSentences();

      return state;
    }

    function hide() {
      state.word = null;
      state.sentencesToken += 1;
      panel.el.classList.add('is-hidden');
    }

    function position(anchorRect) {
      const rect = anchorRect || panel.el.getBoundingClientRect();
      if (!rect || !rect.width) {
        return;
      }

      panel.el.style.left = rect.left + rect.width / 2 + 'px';
      const gap = 8;
      panel.el.style.bottom = (global.innerHeight - rect.top + gap) + 'px';
      panel.el.style.maxHeight = Math.max(160, rect.top - gap - 8) + 'px';
    }

    panel.closeBtn.addEventListener('click', hide);

    panel.usBtn.addEventListener('click', () => {
      if (state.word) {
        speak(state.word, 'en-US');
      }
    });

    panel.ukBtn.addEventListener('click', () => {
      if (state.word) {
        speak(state.word, 'en-GB');
      }
    });

    panel.sentencesBtn.addEventListener('click', () => {
      if (state.word) {
        loadSentences();
      }
    });

    panel.playBtn.addEventListener('click', () => {
      hide();
      if (handlers.onPlay) {
        handlers.onPlay();
      }
    });

    panel.starBtn.addEventListener('click', () => {
      const word = state.word;
      if (!word) {
        return;
      }

      const next = !state.starred;
      setStarred(next);

      if (handlers.setStarred) {
        Promise.resolve(handlers.setStarred(word, next, state.source, state.sentences))
          .then((result) => {
            if (result === false && state.word === word) {
              setStarred(!next);
            }
          })
          .catch(() => {
            if (state.word === word) {
              setStarred(!next);
            }
          });
      }
    });

    return {
      el: panel.el,
      show: show,
      hide: hide,
      position: position,
      isOpen: () => !panel.el.classList.contains('is-hidden'),
      currentWord: () => state.word
    };
  }

  DS.panel = {
    createPanel: createPanel,
    attachPanel: attachPanel,
    speak: speak,
    renderSentences: renderSentences
  };
})(typeof self !== 'undefined' ? self : this);
