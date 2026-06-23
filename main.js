const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron')
const path = require('path')
const fs   = require('fs')
const os   = require('os')
const { exec } = require('child_process')

const PANEL_W  = 320
const STUB_W   = 20   // matches pill width — only the pill sticks out

let win
let screenW, screenH
let isVisible     = false
let isLocked      = false
let isInteracting = false
let sliding       = false
let slideTimer    = null
let hotkey        = 'F9'

app.whenReady().then(() => {
  const display = screen.getPrimaryDisplay()
  screenW = display.bounds.width   // physical screen edge, not work area
  screenH = display.bounds.height

  loadConfig()

  win = new BrowserWindow({
    width: PANEL_W,
    height: screenH,
    x: screenW - STUB_W,  // show as a thin strip from the start
    y: 0,
    alwaysOnTop: true,
    frame: false,
    show: false,
    transparent: true,        // lets background disappear when panel is hidden
    resizable: true,
    fullscreenable: false,
    minWidth: 240,
    maxWidth: 500,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  fs.mkdirSync(path.join(app.getPath('userData'), 'screenshots'), { recursive: true })

  win.once('ready-to-show', () => {
    win.setPosition(screenW - STUB_W, 0)
    win.showInactive()
    win.setIgnoreMouseEvents(true, { forward: true })  // click-through when hidden
  })

  win.webContents.once('did-finish-load', () => {
    win.webContents.send('panel-state', 'closed')
  })

  // If fullscreen somehow happens, kick it back immediately
  win.on('enter-full-screen', () => {
    win.setFullScreen(false)
    win.setSize(PANEL_W, screenH)
    win.setPosition(isVisible ? screenW - PANEL_W : screenW - STUB_W, 0)
  })

  setInterval(pollMouse, 80)
  registerHotkey(hotkey)
})

// ── Mouse edge detection ───────────────────────────────────────────────────
function pollMouse() {
  if (!win) return
  const cursor = screen.getCursorScreenPoint()
  // Trigger zone = the STUB_W strip on the right edge
  const onStub = cursor.x >= screenW - STUB_W

  if (!isVisible) {
    if (onStub) slideIn()
  } else if (!isLocked && !isInteracting) {
    const b = win.getBounds()
    const inPanel = cursor.x >= b.x && cursor.y >= b.y &&
                    cursor.x <= b.x + b.width && cursor.y <= b.y + b.height
    if (!onStub && !inPanel) slideOut()
  }
}

// ── Slide animation ────────────────────────────────────────────────────────
function slideIn() {
  if (sliding || isVisible) return
  isVisible = true
  sliding   = true
  clearSlide()
  win.setIgnoreMouseEvents(false)
  if (win.webContents) win.webContents.send('panel-state', 'open')  // show content before sliding

  const start  = screenW - STUB_W
  const target = screenW - PANEL_W
  win.setPosition(start, 0)

  slideTimer = setInterval(() => {
    if (!win) { clearSlide(); sliding = false; return }
    let [x] = win.getPosition()
    x = Math.max(target, x - 22)
    win.setPosition(x, 0)
    if (x <= target) { clearSlide(); sliding = false }
  }, 8)
}

function slideOut() {
  if (sliding || !isVisible) return
  isVisible = false
  sliding   = true
  clearSlide()

  const target = screenW - STUB_W

  slideTimer = setInterval(() => {
    if (!win) { clearSlide(); sliding = false; return }
    let [x] = win.getPosition()
    x = Math.min(target, x + 22)
    win.setPosition(x, 0)
    if (x >= target) {
      clearSlide(); sliding = false
      win.setIgnoreMouseEvents(true, { forward: true })  // click-through stub area
      if (win && win.webContents) win.webContents.send('panel-state', 'closed')
    }
  }, 8)
}

function clearSlide() {
  if (slideTimer) { clearInterval(slideTimer); slideTimer = null }
}

// ── Hotkey ─────────────────────────────────────────────────────────────────
function registerHotkey(key) {
  globalShortcut.unregisterAll()
  try {
    const ok = globalShortcut.register(key, () => {
      if (isVisible) {
        isLocked = false
        slideOut()
      } else {
        isLocked = true  // pin it so hover-away won't hide it
        slideIn()
      }
    })
    if (!ok) console.warn('Could not register hotkey:', key)
  } catch (e) {
    console.error('Invalid hotkey:', key)
  }
  hotkey = key
  saveConfig()
}

// ── Config ─────────────────────────────────────────────────────────────────
function cfgPath() { return path.join(app.getPath('userData'), 'config.json') }

function loadConfig() {
  try { const c = JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); if (c.hotkey) hotkey = c.hotkey } catch {}
}

function saveConfig() {
  try { fs.writeFileSync(cfgPath(), JSON.stringify({ hotkey }, null, 2)) } catch {}
}

// ── Screen capture via PowerShell + .NET ──────────────────────────────────
ipcMain.handle('capture-screen', async () => {
  const wasVisible = isVisible
  const wasLocked  = isLocked

  clearSlide()
  sliding = false

  // Move fully off-screen for a clean capture
  win.setPosition(screenW, 0)
  await sleep(400)

  const outFile = path.join(os.tmpdir(), `sn_${Date.now()}.png`)
  const psFile  = outFile + '.ps1'
  const script  = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$b = New-Object System.Drawing.Bitmap($s.Width, $s.Height)',
    '$g = [System.Drawing.Graphics]::FromImage($b)',
    '$g.CopyFromScreen([System.Drawing.Point]::Empty, [System.Drawing.Point]::Empty, $b.Size)',
    `$b.Save("${outFile.replace(/\\/g, '\\\\')}")`,
    '$g.Dispose()',
    '$b.Dispose()'
  ].join('\r\n')

  fs.writeFileSync(psFile, script, 'utf8')

  let result = null
  try {
    await new Promise((resolve, reject) => {
      exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`,
        { timeout: 8000 },
        (err) => { try { fs.unlinkSync(psFile) } catch {} ; err ? reject(err) : resolve() })
    })
    if (fs.existsSync(outFile)) {
      result = 'data:image/png;base64,' + fs.readFileSync(outFile).toString('base64')
      try { fs.unlinkSync(outFile) } catch {}
    }
  } catch (err) {
    console.error('Capture failed:', err)
  }

  // Restore window position
  isVisible = wasVisible
  isLocked  = wasLocked
  win.setPosition(wasVisible ? screenW - PANEL_W : screenW - STUB_W, 0)

  return result
})

// ── IPC ────────────────────────────────────────────────────────────────────
ipcMain.handle('get-paths', () => ({
  userData: app.getPath('userData'),
  screenshots: path.join(app.getPath('userData'), 'screenshots')
}))

ipcMain.handle('get-hotkey', () => hotkey)
ipcMain.handle('set-hotkey', (_, key) => { registerHotkey(key); return hotkey })

ipcMain.handle('pause-hotkey',  () => globalShortcut.unregisterAll())
ipcMain.handle('resume-hotkey', () => registerHotkey(hotkey))

ipcMain.handle('set-interacting', (_, val) => { isInteracting = val })

let priorBounds = null

ipcMain.handle('expand-for-editor', () => {
  priorBounds = win.getBounds()
  win.setIgnoreMouseEvents(false)
  win.setBounds({ x: 0, y: 0, width: screenW, height: screenH })
})

ipcMain.handle('collapse-from-editor', () => {
  win.setBounds(priorBounds || { x: screenW - PANEL_W, y: 0, width: PANEL_W, height: screenH })
  priorBounds = null
})

ipcMain.handle('minimize-win', () => win.minimize())

ipcMain.handle('read-json', (_, filePath) => {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { return null }
})
ipcMain.handle('write-json', (_, filePath, data) => {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
})
ipcMain.handle('save-image', (_, filePath, dataUrl) => {
  fs.writeFileSync(filePath, Buffer.from(dataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64'))
})
ipcMain.handle('read-image', (_, filePath) => {
  if (!fs.existsSync(filePath)) return null
  return 'data:image/png;base64,' + fs.readFileSync(filePath).toString('base64')
})
ipcMain.handle('delete-file', (_, filePath) => {
  try { fs.unlinkSync(filePath) } catch {}
})

const sleep = ms => new Promise(r => setTimeout(r, ms))

app.on('window-all-closed', () => app.quit())
