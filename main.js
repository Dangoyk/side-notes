const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')
const fs = require('fs')

let win

app.whenReady().then(() => {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const PANEL_W = 320

  win = new BrowserWindow({
    width: PANEL_W,
    height,
    x: width - PANEL_W,
    y: 0,
    alwaysOnTop: true,
    frame: false,
    resizable: true,
    minWidth: 240,
    maxWidth: 500,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  fs.mkdirSync(path.join(app.getPath('userData'), 'screenshots'), { recursive: true })
})

ipcMain.handle('get-paths', () => ({
  userData: app.getPath('userData'),
  screenshots: path.join(app.getPath('userData'), 'screenshots')
}))

ipcMain.handle('hide-win', () => win.hide())
ipcMain.handle('show-win', () => { win.show(); win.focus() })
ipcMain.handle('minimize-win', () => win.minimize())

ipcMain.handle('read-json', (_, filePath) => {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) }
  catch { return null }
})

ipcMain.handle('write-json', (_, filePath, data) => {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
})

ipcMain.handle('save-image', (_, filePath, dataUrl) => {
  const data = dataUrl.replace(/^data:image\/\w+;base64,/, '')
  fs.writeFileSync(filePath, Buffer.from(data, 'base64'))
})

ipcMain.handle('read-image', (_, filePath) => {
  if (!fs.existsSync(filePath)) return null
  return 'data:image/png;base64,' + fs.readFileSync(filePath).toString('base64')
})

ipcMain.handle('delete-file', (_, filePath) => {
  try { fs.unlinkSync(filePath) } catch {}
})

app.on('window-all-closed', () => app.quit())
