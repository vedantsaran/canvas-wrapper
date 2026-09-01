const WRAPPER_URL = 'https://umd.instructure.com/?elms_local=1';

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id && tab.url?.startsWith('https://umd.instructure.com/')) {
    await chrome.tabs.update(tab.id, { url: WRAPPER_URL });
    return;
  }

  await chrome.tabs.create({ url: WRAPPER_URL });
});
