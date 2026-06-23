/* global require */
const { ipcRenderer, desktopCapturer } = require('electron')
const path = require('path')

// ── State ──────────────────────────────────────────────────────────────────
let appPaths = {}
let notes = []
let shots = []
let activeTab = 'notes'
let editingNoteId = null

// Editor
let editorCanvas, editorCtx
let isDrawing = false
let startX = 0, startY = 0
let currentTool = 'pen'
let currentColor = '#ff3b3b'
let currentSize = 3
let history = []
let originalImageData = null
let editingShotId = null

// ── Boot ───────────────────────────────────────────────────────────────────
async function init() {
  appPaths = await ipcRenderer.invoke('get-paths')
  await loadData()
  renderNotes()
  renderShots()
  bindUI()
  bindKeys()
  await loadHotkeyDisplay()
  calcInit()

  editorCanvas = document.getElementById('editor-canvas')
  editorCtx = editorCanvas.getContext('2d')
  bindEditorCanvas()

  // Update edge handle visibility when panel slides in/out
  ipcRenderer.on('panel-state', (_, state) => {
    document.body.classList.toggle('panel-closed', state === 'closed')
  })
}

// ── Persistence ────────────────────────────────────────────────────────────
async function loadData() {
  const d = await ipcRenderer.invoke('read-json', path.join(appPaths.userData, 'data.json'))
  if (d) { notes = d.notes || []; shots = d.shots || [] }
}

async function saveData() {
  await ipcRenderer.invoke('write-json', path.join(appPaths.userData, 'data.json'), { notes, shots })
}

// ── Notes ──────────────────────────────────────────────────────────────────
function renderNotes() {
  const el = document.getElementById('notes-list')
  if (!notes.length) {
    el.innerHTML = '<div class="empty">No notes yet.<br>Click <b>+ New Note</b> to start.</div>'
    return
  }
  el.innerHTML = [...notes].reverse().map(n => `
    <div class="note-card" data-id="${n.id}" tabindex="0" role="button">
      <div class="note-card-title">${esc(n.title || 'Untitled')}</div>
      <div class="note-card-preview">${esc(n.body.slice(0, 90) || 'Empty')}</div>
      <div class="note-card-date">${fmtDate(n.updated)}</div>
      <button class="note-del-btn" data-id="${n.id}" title="Delete">&#x2715;</button>
    </div>`).join('')

  el.querySelectorAll('.note-card').forEach(c => {
    c.addEventListener('click', e => { if (!e.target.classList.contains('note-del-btn')) openNoteModal(c.dataset.id) })
    c.addEventListener('keydown', e => { if (e.key === 'Enter') openNoteModal(c.dataset.id) })
  })
  el.querySelectorAll('.note-del-btn').forEach(b => {
    b.addEventListener('click', e => { e.stopPropagation(); deleteNote(b.dataset.id) })
  })
}

function openNoteModal(id) {
  editingNoteId = id || null
  const n = id ? notes.find(x => x.id === id) : null
  document.getElementById('note-title-input').value = n ? n.title : ''
  document.getElementById('note-body-input').value  = n ? n.body  : ''
  document.getElementById('note-modal').classList.remove('hidden')
  document.getElementById('note-title-input').focus()
  ipcRenderer.invoke('set-interacting', true)
}

function closeNoteModal() {
  editingNoteId = null
  document.getElementById('note-modal').classList.add('hidden')
  ipcRenderer.invoke('set-interacting', false)
}

async function saveNote() {
  const title = document.getElementById('note-title-input').value.trim()
  const body  = document.getElementById('note-body-input').value
  if (!title && !body) { closeNoteModal(); return }
  const now = Date.now()
  if (editingNoteId) {
    const n = notes.find(x => x.id === editingNoteId)
    if (n) Object.assign(n, { title, body, updated: now })
  } else {
    notes.push({ id: uid(), title, body, created: now, updated: now })
  }
  await saveData()
  renderNotes()
  closeNoteModal()
}

async function deleteNote(id) {
  notes = notes.filter(n => n.id !== id)
  await saveData()
  renderNotes()
}

// ── Screenshots ────────────────────────────────────────────────────────────
function renderShots() {
  const el = document.getElementById('shots-list')
  if (!shots.length) {
    el.innerHTML = '<div class="empty">No screenshots yet.<br>Click <b>Capture</b> to grab one.</div>'
    return
  }
  el.innerHTML = [...shots].reverse().map(s => `
    <div class="shot-card" data-id="${s.id}" tabindex="0" role="button">
      <img src="${s.thumb}" alt="screenshot" loading="lazy">
      <div class="shot-card-info">
        <span class="shot-card-date">${fmtDate(s.created)}</span>
        <button class="shot-del-btn" data-id="${s.id}" title="Delete">&#x2715;</button>
      </div>
    </div>`).join('')

  el.querySelectorAll('.shot-card').forEach(c => {
    c.addEventListener('click', e => { if (!e.target.classList.contains('shot-del-btn')) openViewer(c.dataset.id) })
    c.addEventListener('keydown', e => { if (e.key === 'Enter') openViewer(c.dataset.id) })
  })
  el.querySelectorAll('.shot-del-btn').forEach(b => {
    b.addEventListener('click', e => { e.stopPropagation(); deleteShot(b.dataset.id) })
  })
}

async function captureScreen() {
  try {
    const dataUrl = await ipcRenderer.invoke('capture-screen')
    if (dataUrl) openEditor(dataUrl, null)
  } catch (err) {
    console.error('Capture failed:', err)
  }
}

async function deleteShot(id) {
  const s = shots.find(x => x.id === id)
  if (s?.filePath) await ipcRenderer.invoke('delete-file', s.filePath)
  shots = shots.filter(x => x.id !== id)
  await saveData()
  renderShots()
}

// ── Screenshot editor ──────────────────────────────────────────────────────
function openEditor(dataUrl, shotId) {
  editingShotId = shotId
  history = []
  originalImageData = null

  document.getElementById('editor-modal').classList.remove('hidden')
  ipcRenderer.invoke('set-interacting', true)

  const img = new Image()
  img.onload = () => {
    editorCanvas.width  = img.naturalWidth
    editorCanvas.height = img.naturalHeight
    editorCtx.drawImage(img, 0, 0)
    originalImageData = editorCtx.getImageData(0, 0, editorCanvas.width, editorCanvas.height)
    pushHistory()
  }
  img.src = dataUrl
}

function bindEditorCanvas() {
  let shape = null

  editorCanvas.addEventListener('mousedown', e => {
    const p = canvasPos(e)
    startX = p.x; startY = p.y
    isDrawing = true

    if (currentTool === 'text') {
      isDrawing = false
      showTextInput(p.x, p.y)
      return
    }
    if (currentTool === 'pen' || currentTool === 'eraser') {
      editorCtx.beginPath()
      editorCtx.moveTo(p.x, p.y)
    }
    if (currentTool === 'rect' || currentTool === 'arrow') {
      shape = { x: p.x, y: p.y }
    }
  })

  editorCanvas.addEventListener('mousemove', e => {
    if (!isDrawing) return
    const p = canvasPos(e)

    if (currentTool === 'pen') {
      editorCtx.strokeStyle = currentColor
      editorCtx.lineWidth = currentSize
      editorCtx.lineCap = 'round'
      editorCtx.lineJoin = 'round'
      editorCtx.lineTo(p.x, p.y)
      editorCtx.stroke()
    } else if (currentTool === 'eraser') {
      const r = currentSize * 3
      const dx = Math.max(0, Math.round(p.x - r))
      const dy = Math.max(0, Math.round(p.y - r))
      const dw = Math.min(r * 2, editorCanvas.width  - dx)
      const dh = Math.min(r * 2, editorCanvas.height - dy)
      if (originalImageData && dw > 0 && dh > 0) {
        editorCtx.putImageData(originalImageData, 0, 0, dx, dy, dw, dh)
      }
    } else if (currentTool === 'rect' && shape) {
      restoreTop()
      editorCtx.strokeStyle = currentColor
      editorCtx.lineWidth = currentSize
      editorCtx.strokeRect(shape.x, shape.y, p.x - shape.x, p.y - shape.y)
    } else if (currentTool === 'arrow' && shape) {
      restoreTop()
      drawArrow(shape.x, shape.y, p.x, p.y)
    }
  })

  editorCanvas.addEventListener('mouseup', () => {
    if (isDrawing) { pushHistory(); isDrawing = false; shape = null }
  })
  editorCanvas.addEventListener('mouseleave', () => {
    if (isDrawing && (currentTool === 'pen' || currentTool === 'eraser')) {
      pushHistory(); isDrawing = false
    }
  })
}

function drawArrow(x1, y1, x2, y2) {
  const len = 14
  const angle = Math.atan2(y2 - y1, x2 - x1)
  editorCtx.strokeStyle = editorCtx.fillStyle = currentColor
  editorCtx.lineWidth = currentSize
  editorCtx.lineCap = 'round'
  editorCtx.beginPath()
  editorCtx.moveTo(x1, y1)
  editorCtx.lineTo(x2, y2)
  editorCtx.stroke()
  editorCtx.beginPath()
  editorCtx.moveTo(x2, y2)
  editorCtx.lineTo(x2 - len * Math.cos(angle - Math.PI / 6), y2 - len * Math.sin(angle - Math.PI / 6))
  editorCtx.lineTo(x2 - len * Math.cos(angle + Math.PI / 6), y2 - len * Math.sin(angle + Math.PI / 6))
  editorCtx.closePath()
  editorCtx.fill()
}

function showTextInput(x, y) {
  const overlay = document.getElementById('text-overlay')
  const input   = document.getElementById('text-input')
  overlay.classList.remove('hidden')
  overlay.style.left = x + 'px'
  overlay.style.top  = y + 'px'
  input.style.fontSize = Math.max(13, currentSize * 3) + 'px'
  input.style.color = currentColor
  input.value = ''
  input.focus()

  const commit = () => {
    const txt = input.value.trim()
    if (txt) {
      editorCtx.fillStyle = currentColor
      editorCtx.font = `bold ${Math.max(14, currentSize * 3)}px -apple-system, sans-serif`
      editorCtx.fillText(txt, x, y + Math.max(14, currentSize * 3))
      pushHistory()
    }
    overlay.classList.add('hidden')
    input.onkeydown = null
  }
  input.onkeydown = e => {
    if (e.key === 'Enter')  { e.preventDefault(); commit() }
    if (e.key === 'Escape') { overlay.classList.add('hidden'); input.onkeydown = null }
  }
}

function canvasPos(e) {
  const r = editorCanvas.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}

function pushHistory() {
  history.push(editorCtx.getImageData(0, 0, editorCanvas.width, editorCanvas.height))
  if (history.length > 40) history.shift()
}

function restoreTop() {
  if (history.length) editorCtx.putImageData(history[history.length - 1], 0, 0)
}

function undo() {
  if (history.length > 1) { history.pop(); restoreTop() }
}

async function saveShot() {
  const dataUrl = editorCanvas.toDataURL('image/png')
  const id      = editingShotId || uid()
  const file    = path.join(appPaths.screenshots, `shot_${id}.png`)

  await ipcRenderer.invoke('save-image', file, dataUrl)

  const th = document.createElement('canvas')
  th.width  = 300
  th.height = Math.round(editorCanvas.height * 300 / editorCanvas.width)
  th.getContext('2d').drawImage(editorCanvas, 0, 0, th.width, th.height)
  const thumb = th.toDataURL('image/jpeg', 0.72)

  if (editingShotId) {
    const s = shots.find(x => x.id === editingShotId)
    if (s) Object.assign(s, { thumb, filePath: file })
  } else {
    shots.push({ id, filePath: file, thumb, created: Date.now() })
  }

  await saveData()
  renderShots()
  closeEditor()
  switchTab('shots')
}

function closeEditor() {
  document.getElementById('editor-modal').classList.add('hidden')
  history = []; originalImageData = null; editingShotId = null
  ipcRenderer.invoke('set-interacting', false)
}

// ── Viewer ─────────────────────────────────────────────────────────────────
async function openViewer(id) {
  const s = shots.find(x => x.id === id)
  if (!s) return
  editingShotId = id
  const data = await ipcRenderer.invoke('read-image', s.filePath)
  if (!data) return
  document.getElementById('viewer-img').src = data
  document.getElementById('viewer-modal').classList.remove('hidden')
  ipcRenderer.invoke('set-interacting', true)
}

function closeViewer() {
  document.getElementById('viewer-modal').classList.add('hidden')
  editingShotId = null
  ipcRenderer.invoke('set-interacting', false)
}

// ── Calculator ─────────────────────────────────────────────────────────────
let cVal   = '0'   // display value
let cPrev  = null  // stored operand
let cOp    = null  // pending operator
let cFresh = false // next digit replaces display
let cOpen  = false // calculator expanded

function calcInit() {
  document.getElementById('calc-toggle-btn').addEventListener('click', () => {
    cOpen = !cOpen
    document.getElementById('calc-body').classList.toggle('hidden', !cOpen)
    document.getElementById('calc-arrow').innerHTML = cOpen ? '&#9660;' : '&#9650;'
  })

  document.getElementById('calc-btns').addEventListener('click', e => {
    const btn = e.target.closest('.cb')
    if (!btn) return
    const { action, op, digit } = btn.dataset
    if (action === 'digit')  cDigit(digit)
    if (action === 'dot')    cDot()
    if (action === 'op')     cOperator(op)
    if (action === 'equals') cEquals()
    if (action === 'clear')  cClear()
    if (action === 'sign')   cSign()
    if (action === 'pct')    cPercent()
    cRefresh()
  })
}

function cDigit(d) {
  if (cFresh) { cVal = d === '0' ? '0' : d; cFresh = false }
  else cVal = (cVal === '0') ? d : (cVal.length < 12 ? cVal + d : cVal)
}
function cDot() {
  if (cFresh) { cVal = '0.'; cFresh = false; return }
  if (!cVal.includes('.')) cVal += '.'
}
function cOperator(op) {
  if (cOp && !cFresh) cEquals()
  cPrev = parseFloat(cVal); cOp = op; cFresh = true
}
function cEquals() {
  if (cOp === null || cPrev === null) return
  const cur = parseFloat(cVal)
  let r
  if (cOp === '+') r = cPrev + cur
  else if (cOp === '-') r = cPrev - cur
  else if (cOp === '*') r = cPrev * cur
  else if (cOp === '/') r = cur !== 0 ? cPrev / cur : 'Error'
  else r = cur
  document.getElementById('calc-expr').textContent =
    `${cFmt(cPrev)} ${{'+':`+`,'-':`−`,'*':`×`,'/':`÷`}[cOp]} ${cFmt(cur)} =`
  cVal = r === 'Error' ? 'Error' : cFmt(r)
  cOp = null; cPrev = null; cFresh = true
}
function cClear() {
  cVal = '0'; cPrev = null; cOp = null; cFresh = false
  document.getElementById('calc-expr').textContent = ''
}
function cSign()    { if (cVal !== '0' && cVal !== 'Error') cVal = cVal.startsWith('-') ? cVal.slice(1) : '-' + cVal }
function cPercent() { const n = parseFloat(cVal); if (!isNaN(n)) cVal = cFmt(n / 100) }
function cBackspace() {
  if (cFresh || cVal === 'Error') return
  cVal = cVal.length > 1 ? cVal.slice(0, -1) : '0'
}
function cFmt(n) {
  if (typeof n !== 'number') return String(n)
  const s = parseFloat(n.toFixed(10)).toString()
  return s.length > 12 ? parseFloat(n.toPrecision(8)).toString() : s
}
function cRefresh() {
  document.getElementById('calc-val').textContent = cVal
  document.querySelectorAll('.cb.op').forEach(b =>
    b.classList.toggle('op-active', b.dataset.op === cOp && cFresh))
}

// ── Settings ───────────────────────────────────────────────────────────────
async function loadHotkeyDisplay() {
  const hk = await ipcRenderer.invoke('get-hotkey')
  document.getElementById('hotkey-input').value = hk
}

function openSettings() {
  loadHotkeyDisplay()
  document.getElementById('settings-modal').classList.remove('hidden')
  ipcRenderer.invoke('set-interacting', true)
}

function closeSettings() {
  document.getElementById('settings-modal').classList.add('hidden')
  ipcRenderer.invoke('resume-hotkey')
  ipcRenderer.invoke('set-interacting', false)
}

function bindHotkeyInput() {
  const input = document.getElementById('hotkey-input')

  input.addEventListener('focus', () => {
    input.classList.add('listening')
    input.value = 'Press a key...'
    ipcRenderer.invoke('pause-hotkey')  // stop F9 etc. from triggering while typing
  })

  input.addEventListener('blur', () => {
    input.classList.remove('listening')
  })

  input.addEventListener('keydown', e => {
    e.preventDefault()
    const parts = []
    if (e.ctrlKey)  parts.push('Ctrl')
    if (e.altKey)   parts.push('Alt')
    if (e.shiftKey) parts.push('Shift')
    const k = e.key
    if (!['Control', 'Alt', 'Shift', 'Meta'].includes(k)) {
      parts.push(k.length === 1 ? k.toUpperCase() : k)
    }
    if (parts.length) input.value = parts.join('+')
  })
}

async function editFromViewer() {
  const id = editingShotId
  closeViewer()
  const s = shots.find(x => x.id === id)
  if (!s) return
  const data = await ipcRenderer.invoke('read-image', s.filePath)
  if (data) openEditor(data, id)
}

// ── UI bindings ────────────────────────────────────────────────────────────
function bindUI() {
  // Tabs
  document.querySelectorAll('.tab').forEach(t =>
    t.addEventListener('click', () => switchTab(t.dataset.tab)))

  // Notes
  document.getElementById('btn-new-note').addEventListener('click', () => openNoteModal(null))
  document.getElementById('btn-save-note').addEventListener('click', saveNote)
  document.getElementById('btn-cancel-note').addEventListener('click', closeNoteModal)

  // Screenshots
  document.getElementById('btn-capture').addEventListener('click', captureScreen)

  // Editor tool buttons
  document.querySelectorAll('.tool').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.tool').forEach(x => x.classList.remove('active'))
      b.classList.add('active')
      currentTool = b.dataset.tool
    })
  })
  document.getElementById('color-picker').addEventListener('input', e => { currentColor = e.target.value })
  document.getElementById('size-slider').addEventListener('input',  e => { currentSize  = +e.target.value })
  document.getElementById('btn-undo').addEventListener('click', undo)
  document.getElementById('btn-save-ss').addEventListener('click', saveShot)
  document.getElementById('btn-cancel-editor').addEventListener('click', closeEditor)

  // Viewer
  document.getElementById('btn-edit-from-viewer').addEventListener('click', editFromViewer)
  document.getElementById('btn-close-viewer').addEventListener('click', closeViewer)

  // Window controls
  document.getElementById('btn-minimize').addEventListener('click', () => ipcRenderer.invoke('minimize-win'))
  document.getElementById('btn-close').addEventListener('click', () => window.close())

  // Settings
  document.getElementById('btn-settings').addEventListener('click', openSettings)
  document.getElementById('btn-close-settings').addEventListener('click', closeSettings)
  document.getElementById('btn-apply-hotkey').addEventListener('click', async () => {
    const val = document.getElementById('hotkey-input').value.trim()
    if (val && val !== 'Press a key...') {
      await ipcRenderer.invoke('set-hotkey', val)
    }
    closeSettings()
  })
  bindHotkeyInput()
}

function switchTab(tab) {
  activeTab = tab
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab))
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`))
}

function bindKeys() {
  document.addEventListener('keydown', e => {
    const ctrl = e.ctrlKey || e.metaKey
    const noteOpen   = !document.getElementById('note-modal').classList.contains('hidden')
    const editorOpen = !document.getElementById('editor-modal').classList.contains('hidden')
    const viewerOpen = !document.getElementById('viewer-modal').classList.contains('hidden')

    if (e.key === 'Escape') {
      if (editorOpen) closeEditor()
      else if (noteOpen) closeNoteModal()
      else if (viewerOpen) closeViewer()
      return
    }
    if (ctrl && e.key === 'z' && editorOpen) { e.preventDefault(); undo(); return }
    if (ctrl && e.key === 's') {
      e.preventDefault()
      if (noteOpen) saveNote()
      else if (editorOpen) saveShot()
      return
    }
    if (ctrl && e.shiftKey && e.key === 'S') { e.preventDefault(); captureScreen(); return }
    if (ctrl && e.key === 'n' && !noteOpen && !editorOpen) {
      e.preventDefault(); switchTab('notes'); openNoteModal(null)
    }

    // Calculator keyboard support when calc is open and no modal active
    if (cOpen && !noteOpen && !editorOpen && !viewerOpen &&
        !document.getElementById('settings-modal').classList.contains('hidden') === false) {
      const k = e.key
      if (k >= '0' && k <= '9')  { cDigit(k); cRefresh(); return }
      if (k === '.')              { cDot(); cRefresh(); return }
      if (k === '+')              { cOperator('+'); cRefresh(); return }
      if (k === '-' && !ctrl)     { cOperator('-'); cRefresh(); return }
      if (k === '*')              { cOperator('*'); cRefresh(); return }
      if (k === '/' && !ctrl)     { e.preventDefault(); cOperator('/'); cRefresh(); return }
      if (k === 'Enter')          { cEquals(); cRefresh(); return }
      if (k === 'Backspace' && !noteOpen && !editorOpen) { cBackspace(); cRefresh(); return }
    }
  })

  // Keyboard scroll for scroll-areas
  document.querySelectorAll('.scroll-area').forEach(el => {
    el.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown')  el.scrollBy(0,  60)
      if (e.key === 'ArrowUp')    el.scrollBy(0, -60)
      if (e.key === 'PageDown')   el.scrollBy(0,  el.clientHeight * 0.8)
      if (e.key === 'PageUp')     el.scrollBy(0, -el.clientHeight * 0.8)
    })
  })
}

// ── Utils ──────────────────────────────────────────────────────────────────
const uid     = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const esc     = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
const sleep   = ms => new Promise(r => setTimeout(r, ms))
const fmtDate = ts => {
  const d = new Date(ts)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

init()
