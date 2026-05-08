const { app, BrowserWindow, BrowserView, ipcMain, nativeImage, session } = require('electron')
const path = require('path')
const http = require('http')
const { parsePageForSeniors } = require('../engine/pageParser')
const { checkClickSpeed, checkSessionLimit } = require('../guard/antiAbuse')

const isDev = process.argv.includes('--dev')

// ─── 메인 윈도우 (SlowBro UI) ───────────────────────────────────────────────
let mainWindow
let browserView = null   // 원본 사이트 임베드용

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: 'SlowBro',
    backgroundColor: '#FAFAF8',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,   // 보안: renderer 에서 Node 직접 접근 차단
      nodeIntegration: false,   // 보안: Node API renderer 노출 차단
      sandbox: false,           // preload 에서 require 허용 (contextIsolation과 함께)
    },
  })

  mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'))

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' })
}

// ─── 임베드 WebView 세션 — 광고/트래커 차단 ───────────────────────────────
function setupAdBlockSession() {
  const filter = { urls: ['*://*.doubleclick.net/*', '*://*.googlesyndication.com/*', '*://*.adnxs.com/*'] }
  session.defaultSession.webRequest.onBeforeRequest(filter, (details, callback) => {
    callback({ cancel: true })
  })
}

// ─── IPC 핸들러 ─────────────────────────────────────────────────────────────

// renderer가 URL 로드 요청 → 파싱 후 단순화된 데이터 반환
ipcMain.handle('page:load', async (event, url) => {
  try {
    const result = await parsePageForSeniors(url)
    return { ok: true, data: result }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// 클릭 속도 검사 (매크로 방지)
ipcMain.handle('guard:checkClick', async (event, { sessionId, timestamp }) => {
  const safe = checkClickSpeed(sessionId, timestamp)
  return { safe }
})

// 세션(예매) 중복 제한
ipcMain.handle('guard:checkSession', async (event, { userId, eventId }) => {
  const allowed = checkSessionLimit(userId, eventId)
  return { allowed }
})

// TTS 재생 요청 — Web Speech API를 renderer에서 직접 쓰므로 여기선 로그만
ipcMain.on('tts:speak', (event, text) => {
  console.log('[TTS]', text)
})

// 예매 데이터를 데모 서버(localhost:3000)에 전송
ipcMain.handle('book:submit', async (event, bookingData) => {
  return new Promise((resolve) => {
    const body = JSON.stringify(bookingData)
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: '/api/book',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      },
    }
    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { resolve({ ok: false, error: '응답 파싱 실패' }) }
      })
    })
    req.on('error', (e) => {
      console.warn('[book:submit] 데모 서버 연결 실패 — 서버가 실행 중인지 확인하세요:', e.message)
      resolve({ ok: false, error: '서버에 연결할 수 없어요' })
    })
    req.write(body)
    req.end()
  })
})

// renderer가 canvas로 그린 이모지 PNG를 창 아이콘으로 설정
ipcMain.on('window:set-icon', (event, dataUrl) => {
  const icon = nativeImage.createFromDataURL(dataUrl)
  mainWindow?.setIcon(icon)
})

// ─── BrowserView (원본 사이트 임베드) ─────────────────────────────────────────

// URL을 BrowserView에 열기 — bounds는 renderer에서 계산해서 넘겨줌
ipcMain.handle('browser:open', async (event, { url, bounds }) => {
  if (!browserView) {
    browserView = new BrowserView({
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    })
    mainWindow.addBrowserView(browserView)

    browserView.webContents.on('did-navigate', (_, navUrl) => {
      mainWindow.webContents.send('browser:url-changed', navUrl)
    })
    browserView.webContents.on('did-navigate-in-page', (_, navUrl) => {
      mainWindow.webContents.send('browser:url-changed', navUrl)
    })
    browserView.webContents.on('page-title-updated', (_, title) => {
      mainWindow.webContents.send('browser:title-changed', title)
    })
    browserView.webContents.on('did-start-loading', () => {
      mainWindow.webContents.send('browser:loading', true)
    })
    browserView.webContents.on('did-stop-loading', () => {
      mainWindow.webContents.send('browser:loading', false)
    })
  }

  browserView.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height })
  await browserView.webContents.loadURL(url).catch(() => {})
  return { ok: true }
})

// BrowserView 닫기
ipcMain.handle('browser:close', async () => {
  if (browserView) {
    mainWindow.removeBrowserView(browserView)
    browserView.webContents.destroy()
    browserView = null
  }
  return { ok: true }
})

// 내비게이션 컨트롤
ipcMain.handle('browser:navigate', async (_, url) => {
  if (!browserView) return { ok: false }
  await browserView.webContents.loadURL(url).catch(() => {})
  return { ok: true }
})
ipcMain.handle('browser:back',    async () => { browserView?.webContents.canGoBack()    && browserView.webContents.goBack() })
ipcMain.handle('browser:forward', async () => { browserView?.webContents.canGoForward() && browserView.webContents.goForward() })
ipcMain.handle('browser:reload',  async () => { browserView?.webContents.reload() })

// 창 크기 바뀌면 bounds 재조정
ipcMain.handle('browser:setBounds', async (_, bounds) => {
  browserView?.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height })
})

// 페이지 로드 완료까지 대기 (최대 6초)
ipcMain.handle('browser:waitLoad', () => {
  return new Promise((resolve) => {
    if (!browserView) { resolve(false); return }
    if (!browserView.webContents.isLoading()) { resolve(true); return }
    const t = setTimeout(() => resolve(true), 6000)
    browserView.webContents.once('did-stop-loading', () => { clearTimeout(t); resolve(true) })
  })
})

// 로그인 버튼 하이라이트 주입
ipcMain.handle('browser:injectHighlight', async (_, { selectors }) => {
  if (!browserView) return { ok: false, found: false }

  const selectorsJson = JSON.stringify(selectors || [])
  const found = await browserView.webContents.executeJavaScript(`
    (function() {
      // 애니메이션 CSS 주입 (중복 방지)
      if (!document.getElementById('_sb_styles')) {
        const s = document.createElement('style')
        s.id = '_sb_styles'
        s.textContent = \`
          @keyframes _sb_pulse {
            0%, 100% { box-shadow: 0 0 0 4px rgba(255,60,60,0.9), 0 0 24px rgba(255,60,60,0.4); }
            50%       { box-shadow: 0 0 0 12px rgba(255,60,60,0), 0 0 8px rgba(255,60,60,0.1); }
          }
          ._sb_highlight {
            outline: 4px solid #ff3c3c !important;
            outline-offset: 4px !important;
            border-radius: 6px !important;
            animation: _sb_pulse 1.3s ease-in-out infinite !important;
            position: relative !important;
            z-index: 99998 !important;
          }
        \`
        document.head.appendChild(s)
      }

      // 기존 하이라이트 제거
      document.querySelectorAll('._sb_highlight').forEach(el => el.classList.remove('_sb_highlight'))

      // 로그인 버튼 탐색
      const sels = ${selectorsJson}
      let btn = null
      for (const sel of sels) {
        try { btn = document.querySelector(sel); if (btn) break } catch {}
      }

      if (btn) {
        btn.classList.add('_sb_highlight')
        btn.scrollIntoView({ behavior: 'smooth', block: 'center' })
        return true
      }
      return false
    })()
  `).catch(() => false)

  return { ok: true, found }
})

// ─── 앱 라이프사이클 ─────────────────────────────────────────────────────────
app.whenReady().then(() => {
  setupAdBlockSession()
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
