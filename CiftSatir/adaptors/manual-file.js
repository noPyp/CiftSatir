(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});
  const { EN, TR, HIDDEN_CLASS } = DS.constants;

  const subtitleExtensions = /\.(srt|vtt|ttml|dfxp|txt)$/i;

  function isSubtitleFile(file) {
    return Boolean(file) && (subtitleExtensions.test(file.name || '') ||
      /^text\/(vtt|plain)/.test(file.type || ''));
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('Dosya okunamadı.'));
      reader.readAsText(file, 'utf-8');
    });
  }

  // The manually loaded file is the source of truth for whichever channel the
  // user picks, since it is the only path that works when a site burns its
  // subtitles into the video.
  async function loadFiles(files, store, ctx) {
    const accepted = Array.from(files || []).filter(isSubtitleFile);
    if (!accepted.length) {
      return { loaded: 0 };
    }

    let loaded = 0;

    for (const file of accepted) {
      const text = await readFile(file);
      const cues = DS.parsers.parse(text, file.name);
      if (!cues.length) {
        continue;
      }

      // A filename hint picks the channel; otherwise the first file is English
      // and the second is Turkish, which is the common dual-subtitle case.
      const name = (file.name || '').toLowerCase();
      let kind;
      if (/(^|[^a-z])(tr|tur|turkish|türkçe)/.test(name)) {
        kind = TR;
      } else if (/(^|[^a-z])(en|eng|english|ingilizce)/.test(name)) {
        kind = EN;
      } else {
        kind = store.has(EN) && !store.has(TR) ? TR : EN;
      }

      store.set(kind, cues, { source: 'manual-file', label: file.name });
      loaded += 1;
      ctx.emit('cues', { kind: kind, cues: cues, source: 'manual-file' });
    }

    return { loaded: loaded };
  }

  function createDropZone(onDrop) {
    const zone = document.createElement('div');
    zone.className = 'dualsub-dropzone ' + HIDDEN_CLASS;
    zone.textContent = 'Altyazı dosyasını buraya bırak (.srt / .vtt)';

    let depth = 0;

    function show() {
      zone.classList.remove(HIDDEN_CLASS);
    }

    function hide() {
      depth = 0;
      zone.classList.add(HIDDEN_CLASS);
    }

    const onDragEnter = (event) => {
      if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes('Files')) {
        return;
      }
      depth += 1;
      show();
    };

    const onDragOver = (event) => {
      if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files')) {
        event.preventDefault();
      }
    };

    const onDragLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        hide();
      }
    };

    const onDropEvent = (event) => {
      const files = event.dataTransfer && event.dataTransfer.files;
      if (!files || !files.length) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      hide();
      onDrop(files);
    };

    global.addEventListener('dragenter', onDragEnter, true);
    global.addEventListener('dragover', onDragOver, true);
    global.addEventListener('dragleave', onDragLeave, true);
    global.addEventListener('drop', onDropEvent, true);

    // Turning the extension off and on again used to add another set of global
    // drag listeners every time; the destroy hook removes them with the layer.
    function destroy() {
      global.removeEventListener('dragenter', onDragEnter, true);
      global.removeEventListener('dragover', onDragOver, true);
      global.removeEventListener('dragleave', onDragLeave, true);
      global.removeEventListener('drop', onDropEvent, true);
    }

    return { el: zone, show: show, hide: hide, destroy: destroy };
  }

  DS.adaptors = DS.adaptors || {};
  DS.adaptors.manualFile = {
    id: 'manual-file',
    isSubtitleFile: isSubtitleFile,
    readFile: readFile,
    loadFiles: loadFiles,
    createDropZone: createDropZone
  };
})(typeof self !== 'undefined' ? self : this);
