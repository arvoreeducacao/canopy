const input = document.getElementById('secret')
const msg = document.getElementById('msg')

chrome.storage.local.get('canopySecret').then(({ canopySecret = '' }) => {
  input.value = canopySecret
})

document.getElementById('save').addEventListener('click', async () => {
  const canopySecret = input.value.trim()
  await chrome.storage.local.set({ canopySecret })
  // The service worker watches storage and reconnects on its own.
  msg.textContent = canopySecret ? 'saved — reconnecting' : 'cleared'
  setTimeout(() => { msg.textContent = '' }, 2500)
})
