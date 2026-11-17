import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { app, BrowserWindow } from 'electron'
import { closeDatabase, openDatabase } from './db'
import { createRuntime, startRuntime, type Runtime } from './runtime'
import { createMainWindow, showMainWindow } from './window'
import { TrayController } from './tray'
import { applyLoginItem, notifyRenderer, registerIpcHandlers } from './ipc/handlers'
import { closeAllReadonly } from './collectors/sqlite-reader'
import { appConfigDir } from './collectors/paths'

// 固定应用名，保证 dev 与打包后 userData 路径一致
app.setName('AI Task Monitor')

let runtime: Runtime | null = null
let tray: TrayController | null = null
let quitting = false

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  app.whenReady().then(bootstrap).catch((error: unknown) => {
    console.error('[main] bootstrap failed', error)
    app.quit()
  })
}

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData')
  const db = openDatabase(join(userData, 'monitor.db'))

  runtime = createRuntime(db, {
    bridgeTokenFile: join(appConfigDir(userData), 'bridge-token'),
    hooks: {
      onSnapshot: (snapshot) => {
        notifyRenderer(snapshot)
        tray?.update()
      },
      onTray: () => tray?.update()
    }
  })

  tray = new TrayController({
    snapshot: () => runtime?.getSnapshot() ?? null,
    onTogglePause: () => {
      if (!runtime) return
      runtime.updateSettings({ paused: !runtime.getSettings().paused })
      runtime.publish()
    },
    onShow: () => showMainWindow(),
    onQuit: () => app.quit()
  })

  registerIpcHandlers(runtime)
  applyLoginItem(runtime.getSettings())

  if (process.env.ATM_SMOKE === '1') {
    // 自检模式：不创建窗口，采集若干秒后打印诊断信息并退出
    await startRuntime(runtime)
    runSmokeMode()
    return
  }

  createMainWindow()
  tray.init()
  await startRuntime(runtime)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    else showMainWindow()
  })
}

/** ATM_SMOKE=1 时运行：验证数据库、适配器、桥接与快照链路 */
function runSmokeMode(): void {
  const capture = process.env.ATM_SMOKE_CAPTURE === '1'
  if (capture) {
    const win = createMainWindow()
    win.webContents.on('console-message', (_event, level, message) => {
      console.log(`[renderer:${level}] ${message}`)
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      console.error('[renderer] process gone', details.reason)
    })
    win.webContents.on('did-fail-load', (_event, code, description) => {
      console.error(`[renderer] load failed ${code} ${description}`)
    })
    setTimeout(() => {
      void captureUi(win)
    }, 9_000)
  }

  setTimeout(() => {
    if (!runtime) return
    const snapshot = runtime.getSnapshot()
    console.log(
      '[smoke] adapters',
      JSON.stringify(
        runtime.adapters.getInfos().map((adapter) => ({
          id: adapter.id,
          status: adapter.status,
          installed: adapter.installed,
          channel: adapter.channel,
          events: adapter.eventsToday,
          path: adapter.dataPath,
          message: adapter.message
        })),
        null,
        1
      )
    )
    console.log('[smoke] summary', JSON.stringify(snapshot?.summary))
    console.log(
      '[smoke] tasks',
      JSON.stringify(
        (snapshot?.tasks ?? []).slice(0, 10).map((task) => ({
          tool: task.tool,
          title: task.title,
          status: task.status,
          tokens: task.inputTokens + task.outputTokens + task.cacheReadTokens,
          cost: Number(task.costUsd.toFixed(4)),
          source: task.tokensSource
        })),
        null,
        1
      )
    )
    const week = runtime.getStats(Date.now() - 7 * 86_400_000, Date.now())
    console.log(
      '[smoke] stats',
      JSON.stringify({
        days: week.daily.length,
        byTool: week.byTool.map((row) => ({
          tool: row.tool,
          tasks: row.tasks,
          cost: Number(row.costUsd.toFixed(2))
        })),
        top: week.topTasks.length,
        buckets: week.durationBuckets
      })
    )
    console.log('[smoke] bridge', JSON.stringify(runtime.bridgeStatus()))
    void runtime.shutdown().finally(() => {
      closeAllReadonly()
      closeDatabase()
      app.exit(0)
    })
  }, capture ? 46_000 : 12_000)
}

/** 逐页截图，便于人工核对界面（仅自检模式） */
async function captureUi(win: Electron.BrowserWindow): Promise<void> {
  const pages = ['概览', '任务', '统计', '适配器', '设置']
  try {
    win.show()
    win.focus()
    if (win.webContents.isLoading()) {
      await new Promise<void>((resolve) => {
        win.webContents.once('did-finish-load', () => resolve())
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000))

    for (let i = 0; i < pages.length; i += 1) {
      const label = pages[i]
      if (i > 0) {
        const clicked = await win.webContents.executeJavaScript(
          `(() => {
             const btn = Array.from(document.querySelectorAll('button'))
               .find((el) => (el.textContent || '').trim() === ${JSON.stringify(label)});
             if (btn) btn.click();
             return !!btn;
           })()`
        )
        await new Promise((resolve) => setTimeout(resolve, 2_200))
        const heading = await win.webContents.executeJavaScript(
          `(document.querySelector('h1') || {}).textContent || 'n/a'`
        )
        console.log(`[smoke] nav ${label} clicked=${clicked} heading=${heading}`)
      }
      // 后台窗口的 CSS 动画会被节流，先强制收尾，避免截到半透明的过渡帧
      await win.webContents.executeJavaScript(
        'document.getAnimations().forEach((a) => { try { a.finish() } catch (e) {} }); true'
      )
      // 先丢弃一帧再截取：无焦点窗口的首次 capturePage 常返回上一状态的合成帧
      win.webContents.invalidate()
      await win.webContents.capturePage()
      await new Promise((resolve) => setTimeout(resolve, 450))
      const image = await win.webContents.capturePage()
      const target = join(app.getPath('temp'), `atm-shot-${i + 1}-${label}.png`)
      await writeFile(target, image.toPNG())
      console.log(`[smoke] screenshot ${target}`)

      if (label === '适配器' || label === '设置') {
        await win.webContents.executeJavaScript(
          `(() => { const main = document.querySelector('main'); if (main) main.scrollTop = main.scrollHeight; return true })()`
        )
        await new Promise((resolve) => setTimeout(resolve, 900))
        win.webContents.invalidate()
        await win.webContents.capturePage()
        await new Promise((resolve) => setTimeout(resolve, 400))
        const bottom = await win.webContents.capturePage()
        const bottomPath = join(app.getPath('temp'), `atm-shot-${i + 1}-${label}-bottom.png`)
        await writeFile(bottomPath, bottom.toPNG())
        console.log(`[smoke] screenshot ${bottomPath}`)
        await win.webContents.executeJavaScript(
          `(() => { const main = document.querySelector('main'); if (main) main.scrollTop = 0; return true })()`
        )
      }

      if (label === '设置') {
        // 验证目录栏吸附：滚到底部后 nav 仍应停留在可视区顶部
        const sticky = await win.webContents.executeJavaScript(
          `(async () => {
             const main = document.querySelector('main');
             const nav = Array.from(document.querySelectorAll('nav'))
               .find((el) => (el.textContent || '').includes('采集与刷新'));
             if (!main || !nav) return JSON.stringify({ error: 'not-found' });
             main.scrollTop = main.scrollHeight;
             await new Promise((r) => setTimeout(r, 400));
             const navRect = nav.getBoundingClientRect();
             const mainRect = main.getBoundingClientRect();
             const result = {
               scrollTop: Math.round(main.scrollTop),
               navTop: Math.round(navRect.top),
               mainTop: Math.round(mainRect.top),
               navVisible: navRect.top >= mainRect.top - 2 && navRect.bottom <= window.innerHeight
             };
             main.scrollTop = 0;
             return JSON.stringify(result);
           })()`
        )
        console.log('[smoke] sticky-nav', sticky)
      }

      if (label === '概览') {
        // 验证侧边栏折叠不会引起页面上下位移
        const shift = await win.webContents.executeJavaScript(
          `(async () => {
             const firstNavIcon = () => {
               const aside = document.querySelector('aside');
               const btn = aside ? aside.querySelector('nav button') : null;
               const svg = btn ? btn.querySelector('svg') : null;
               return svg ? Math.round(svg.getBoundingClientRect().left * 10) / 10 : -1;
             };
             const cardY = () => {
               const el = Array.from(document.querySelectorAll('p'))
                 .find((p) => (p.textContent || '').trim() === '运行中任务');
               return el ? Math.round(el.getBoundingClientRect().top) : -1;
             };
             const sidebarBottomY = () => {
               const aside = document.querySelector('aside');
               const buttons = aside ? Array.from(aside.querySelectorAll('button')) : [];
               const last = buttons[buttons.length - 1];
               return last ? Math.round(last.getBoundingClientRect().top) : -1;
             };
             const brandY = () => {
               const el = document.querySelector('aside .rounded-\\\\[9px\\\\]');
               return el ? Math.round(el.getBoundingClientRect().top) : -1;
             };
             const toggle = Array.from(document.querySelectorAll('button'))
               .find((b) => (b.getAttribute('title') || '').includes('侧边栏'));
             const before = { card: cardY(), sidebar: sidebarBottomY(), brand: brandY() };
             if (toggle) toggle.click();
             const trace = [firstNavIcon()];
             for (let i = 0; i < 7; i += 1) {
               await new Promise((r) => setTimeout(r, 40));
               trace.push(firstNavIcon());
             }
             await new Promise((r) => setTimeout(r, 300));
             const collapsed = { card: cardY(), sidebar: sidebarBottomY() };
             if (toggle) toggle.click();
             await new Promise((r) => setTimeout(r, 600));
             const restored = { card: cardY(), sidebar: sidebarBottomY() };
             return JSON.stringify({ before, collapsed, restored, iconTrace: trace });
           })()`
        )
        console.log('[smoke] collapse-shift', shift)
      }

      if (label === '概览') {
        // 验证「进行中任务」指标与实时任务卡片数量一致（含静默）
        const consistency = await win.webContents.executeJavaScript(
          `(() => {
             const label = Array.from(document.querySelectorAll('p'))
               .find((p) => (p.textContent || '').trim() === '进行中任务');
             const card = label ? label.closest('.glass') : null;
             const text = card ? card.textContent || '' : '';
             const value = (text.match(/进行中任务\\s*(\\d+)/) || [])[1] || 'n/a';
             const cards = Array.from(document.querySelectorAll('button')).filter((b) => {
               const cls = b.className || '';
               return cls.includes('rounded-2xl') && cls.includes('text-left');
             });
             const statuses = cards.map((b) => {
               const t = b.textContent || '';
               if (t.includes('运行中')) return 'running';
               if (t.includes('静默')) return 'idle';
               return 'unknown';
             });
             return JSON.stringify({ metric: value, cards: cards.length, statuses });
           })()`
        )
        console.log('[smoke] overview-consistency', consistency)
      }

      if (label === '概览') {
        // 验证「切换币种即刻刷新」：点击 CNY → 600ms 内指标卡应变成 ¥
        const probe = await win.webContents.executeJavaScript(
          `(async () => {
             const cardCost = () => {
               const cards = Array.from(document.querySelectorAll('div'));
               const card = cards.find(
                 (el) =>
                   el.className.includes('glass') &&
                   (el.textContent || '').includes('今日费用') &&
                   (el.textContent || '').length < 140
               );
               const text = card ? card.textContent || '' : '';
               const hit = text.match(/[$¥][\\d.,]+/);
               return hit ? hit[0] : 'n/a';
             };
             const clickCurrency = (label) => {
               const btn = Array.from(document.querySelectorAll('button'))
                 .find((el) => (el.textContent || '').trim() === label);
               if (btn) btn.click();
             };
             const initial = cardCost();
             clickCurrency('$ USD');
             await new Promise((r) => setTimeout(r, 600));
             const usd = cardCost();
             clickCurrency('¥ CNY');
             await new Promise((r) => setTimeout(r, 600));
             const cny = cardCost();
             return JSON.stringify({ initial, usd, cny });
           })()`
        )
        console.log('[smoke] currency-probe', probe)
        await new Promise((resolve) => setTimeout(resolve, 600))
      }

      if (label === '统计') {
        // 验证自定义区间：把起止都设为今天，结果应与「今日」一致
        const rangeProbe = await win.webContents.executeJavaScript(
          `(async () => {
             const readCost = () => {
               const p = Array.from(document.querySelectorAll('p'))
                 .find((el) => (el.textContent || '').trim() === '区间费用');
               const card = p ? p.closest('.glass') : null;
               if (!card) return 'n/a';
               const m = (card.textContent || '').match(/[¥$][0-9,]*(\.[0-9]+)?/);
               return m ? m[0] : 'n/a';
             };
             const clickRange = (label) => {
               const btn = Array.from(document.querySelectorAll('button'))
                 .find((b) => (b.textContent || '').trim() === label);
               if (btn) btn.click();
             };
             const wait = (ms) => new Promise((r) => setTimeout(r, ms));
             clickRange('今日');
             await wait(900);
             const todayCost = readCost();
             clickRange('自定义');
             await wait(400);
             const inputs = Array.from(document.querySelectorAll('input[type=date]'));
             const setValue = (el, v) => {
               const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
               setter.call(el, v);
               el.dispatchEvent(new Event('input', { bubbles: true }));
             };
             const d = new Date();
             const pad = (n) => String(n).padStart(2, '0');
             const today = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
             if (inputs[0]) setValue(inputs[0], today);
             if (inputs[1]) setValue(inputs[1], today);
             await wait(1200);
             const customCost = readCost();
             return JSON.stringify({ inputs: inputs.length, todayCost, customCost, equal: todayCost === customCost });
           })()`
        )
        console.log('[smoke] custom-range', rangeProbe)
      }

      if (label === '统计') {
        const diag = await win.webContents.executeJavaScript(
          `(() => {
             const areas = document.querySelectorAll('.recharts-area-area');
             const first = areas[0];
             const svg = document.querySelector('.recharts-surface');
             const clip = document.querySelector('.recharts-area clipPath rect');
             const group = document.querySelector('.recharts-area');
             const rect = first ? first.getBoundingClientRect() : null;
             return JSON.stringify({
               areas: areas.length,
               pathRect: rect ? [Math.round(rect.width), Math.round(rect.height)] : null,
               svgRect: svg ? [Math.round(svg.getBoundingClientRect().width), Math.round(svg.getBoundingClientRect().height)] : null,
               clip: clip ? [clip.getAttribute('width'), clip.getAttribute('height')] : null,
               groupStyle: group ? group.getAttribute('style') : null,
               groupOpacity: group ? getComputedStyle(group).opacity : null,
               stroke: first ? first.getAttribute('stroke') : null,
               fillOpacity: first ? first.getAttribute('fill-opacity') : null
             });
           })()`
        )
        console.log('[smoke] chart-diag', diag)
      }
    }
  } catch (error) {
    console.error('[smoke] capture failed', error)
  }
}

// 托盘常驻：关闭窗口不退出应用
app.on('window-all-closed', () => {
  if (process.platform === 'win32') return
  // macOS / Linux 保持后台运行，由托盘菜单退出
})

app.on('before-quit', (event) => {
  if (quitting || !runtime) return
  event.preventDefault()
  quitting = true
  void runtime
    .shutdown()
    .catch((error: unknown) => console.error('[main] shutdown failed', error))
    .finally(() => {
      closeAllReadonly()
      closeDatabase()
      tray?.destroy()
      app.exit(0)
    })
})
