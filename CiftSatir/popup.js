document.addEventListener('DOMContentLoaded', () => {
  const toggleButton = document.getElementById('toggleButton');
  const englishStatus = document.getElementById('englishStatus');
  const turkishStatus = document.getElementById('turkishStatus');
  const videoStatus = document.getElementById('videoStatus');

  function setMessage(text, isError = false) {
    videoStatus.textContent = text;
    videoStatus.classList.toggle('error', isError);
  }

  function updateStatus(enabled, hasVideo, isError = false) {
    const englishOn = enabled && hasVideo;
    const turkishOn = enabled && hasVideo;

    englishStatus.textContent = englishOn ? 'On' : 'Off';
    englishStatus.classList.toggle('on', englishOn);
    englishStatus.classList.toggle('off', !englishOn);

    turkishStatus.textContent = turkishOn ? 'On' : 'Off';
    turkishStatus.classList.toggle('on', turkishOn);
    turkishStatus.classList.toggle('off', !turkishOn);

    toggleButton.textContent = enabled ? 'Disable subtitles' : 'Enable subtitles';

    if (isError) {
      setMessage('ÇiftSatır is not available on this page.', true);
      return;
    }

    if (!hasVideo) {
      setMessage('No HTML5 video detected on this page.');
      return;
    }

    setMessage('Video detected. ÇiftSatır is active.');
  }

  function sendMessageToTab(tabId, message) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }

        if (!response) {
          resolve({ ok: false, error: 'The content script returned no response.' });
          return;
        }

        resolve({ ok: true, response });
      });
    });
  }

  function showMessageFailure(error) {
    const detail = String(error || '').toLowerCase();

    updateStatus(false, false, true);

    if (detail.includes('receiving end does not exist') || detail.includes('could not establish connection')) {
      setMessage('ÇiftSatır content script did not respond. Reload this tab after installing or updating the extension.', true);
      return;
    }

    if (detail.includes('cannot access contents') || detail.includes('cannot access a chrome') || detail.includes('not allowed')) {
      setMessage('Opera blocked access to this page. For file:// pages, enable "Allow access to file URLs" in the extension details.', true);
      return;
    }

    setMessage('Could not communicate with ÇiftSatır: ' + (error || 'unknown messaging error'), true);
  }

  function applyResponse(result) {
    if (!result.ok) {
      showMessageFailure(result.error);
      return;
    }

    const response = result.response;
    if (typeof response.enabled !== 'boolean' || typeof response.hasVideo !== 'boolean') {
      showMessageFailure('ÇiftSatır returned an invalid state response.');
      return;
    }

    updateStatus(response.enabled, response.hasVideo, false);
  }

  async function refreshState() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || typeof tab.id !== 'number') {
        updateStatus(false, false, true);
        setMessage('No active tab found.', true);
        return;
      }

      const result = await sendMessageToTab(tab.id, { type: 'get-state' });
      applyResponse(result);
    } catch (error) {
      showMessageFailure(error instanceof Error ? error.message : error);
    }
  }

  async function toggleSubtitles() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || typeof tab.id !== 'number') {
        setMessage('There is no active tab to update.', true);
        return;
      }

      const result = await sendMessageToTab(tab.id, { type: 'toggle-subtitles' });
      applyResponse(result);
    } catch (error) {
      showMessageFailure(error instanceof Error ? error.message : error);
    }
  }

  toggleButton.addEventListener('click', toggleSubtitles);
  refreshState();
});
