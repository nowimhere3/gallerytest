"""Real Chromium loading-surface regression; isolated profile and test-only module hooks.
Provider gates hold actual intake at its I/O boundary, never delay production loading.
"""
import os, sys, threading, http.server, socketserver, tempfile, shutil, json
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.path.insert(0, str(Path(os.environ['TEMP']) / 'pm-ui-playwright'))
    from playwright.sync_api import sync_playwright

class Quiet(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw): super().__init__(*a, directory=str(ROOT), **kw)
    def log_message(self, *a): pass

HOOKS = '''
window.__arcadeTest = {
  state: () => ({ loading:isLoadingFiles, raf:arcadeRafId, canvas:arcadeCanvas?.id,
    scene:!!arcadeCurrentScene, warm:warmStartState, textTimer:mobileTakeoverTextTimer }),
  arm: (kind, fail=false) => {
    const owner = kind==='files' ? provider : kind==='folder' ? fsaProvider : remoteProvider;
    const key = kind==='files' ? 'loadFromFileList' : kind==='folder' ? 'loadFromDirectoryHandle' : 'loadFromUrls';
    const original = owner[key];
    owner[key] = async function(...args) {
      owner[key] = original;
      await new Promise(resolve => window.__releaseArcadeIO = resolve);
      if(fail) throw new Error('controlled scan failure');
      return original.apply(this,args);
    };
  },
  warm: () => {
    warmStartState='warming'; warmStartStartedAt=performance.now();
    warmStartOverlay.classList.remove('hidden'); startArcadeAnimation(warmStartCanvas);
    warmStartTimeoutId=setTimeout(()=>finishWarmStart('test-timeout',0),60000);
  },
  lateWarm: () => { finishWarmStart('late-release',0); maybeBeginWarmStart(); }
};
'''
server=socketserver.ThreadingTCPServer(('127.0.0.1',0),Quiet)
threading.Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_address[1]}'
try:
    with tempfile.TemporaryDirectory() as tmp, sync_playwright() as pw:
        folder=Path(tmp)/'images'; folder.mkdir()
        image=folder/'picture.png'; shutil.copyfile(ROOT/'NEW-redesign-Winner So far.png',image)
        browser=pw.chromium.launch(executable_path=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',headless=True)
        for width, reduced in [(1440,False),(390,False),(1440,True),(390,True)]:
            context=browser.new_context(viewport={'width':width,'height':1000},reduced_motion='reduce' if reduced else 'no-preference')
            page=context.new_page(); errors=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.route('**/src/main.js',lambda r:r.fulfill(status=200,content_type='text/javascript',body=(ROOT/'src/main.js').read_text(encoding='utf-8')+HOOKS))
            page.goto(base); page.wait_for_function('!!window.__arcadeTest')
            page.evaluate('''async base => {
              const root=await navigator.storage.getDirectory();
              const dir=await root.getDirectoryHandle('arcade-pictures',{create:true});
              const file=await dir.getFileHandle('picture.png',{create:true});
              const out=await file.createWritable(); await out.write(await(await fetch(base+'/NEW-redesign-Winner%20So%20far.png')).blob()); await out.close();
              const floppy=await root.getFileHandle('arcade-links.txt',{create:true});
              const w=await floppy.createWritable(); await w.write(base+'/NEW-redesign-Winner%20So%20far.png'); await w.close();
              window.showDirectoryPicker=async()=>dir; window.showOpenFilePicker=async()=>[floppy];
            }''',base)
            def trigger(kind):
                if kind=='Open Files': page.locator('#file-input').set_input_files(str(image))
                elif kind=='Open Folder': page.locator('#folder-input').set_input_files(str(folder))
                elif kind=='Remember Folder': page.locator('#fsa-choose-folder-btn').dispatch_event('click')
                elif kind=='Floppy': page.locator('#cassette-add-btn').dispatch_event('click')
                else: page.locator('#fsa-recent-libraries .fsa-recent-library-btn').filter(has_text='arcade-pictures').dispatch_event('click')
            for kind in ['Open Files','Open Folder','Remember Folder','Saved reopen','Floppy','failure']:
                owner='files' if kind in ['Open Files','Open Folder','failure'] else 'remote' if kind=='Floppy' else 'folder'
                page.evaluate('([owner,fail])=>__arcadeTest.arm(owner,fail)',[owner,kind=='failure'])
                # Loading must take ownership even when warm-up already owns the engine.
                page.evaluate('()=>__arcadeTest.warm()')
                trigger('Open Files' if kind=='failure' else kind)
                page.wait_for_function('typeof window.__releaseArcadeIO === "function" && __arcadeTest.state().loading')
                canvas_id = 'viewer-loading-canvas' if width>980 else 'mobile-load-canvas'
                canvas = page.locator('#'+canvas_id)
                canvas.wait_for(state='visible')
                state=page.evaluate('()=>__arcadeTest.state()')
                assert state['canvas']==canvas_id and state['scene'] and state['warm']=='inactive',state
                assert (state['raf'] is None)==reduced,state
                page.evaluate('()=>__arcadeTest.lateWarm()')
                assert page.evaluate('()=>__arcadeTest.state().scene'), 'late warm release killed loading'
                assert canvas.evaluate("e=>!!e.closest('[aria-hidden=true]')")
                if width>980:
                    assert page.locator('.media-content').is_visible(), 'desktop Gallery hidden'
                    assert not page.locator('.mobile-load-takeover').is_visible(), 'residual Live Status card'
                    assert page.locator('#viewer-loading-overlay').evaluate('(e)=>getComputedStyle(e).pointerEvents')=='none'
                    assert canvas.bounding_box()['width']==480
                    assert canvas.evaluate("e=>!!e.closest('#viewer-panel')")
                    overlay=page.locator('#viewer-loading-overlay').bounding_box()
                    viewer=page.locator('#viewer-panel').bounding_box()
                    assert abs(overlay['x']-viewer['x'])<=1 and abs(overlay['width']-viewer['width'])<=2
                else:
                    assert not page.locator('.media-content').is_visible(), 'compact takeover changed'
                    assert page.locator('#mobile-load-primary-text').is_visible()
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'horizontal overflow'
                # Capture actual painted pixels; moving and reduced-motion scenes must both paint.
                page.wait_for_function('''id => {const a=document.getElementById(id).getContext('2d').getImageData(0,0,160,64).data;return a.some((v,i)=>i%4!==3 && v>30);}''', arg=canvas_id)
                if kind=='Open Files' and not reduced:
                    page.screenshot(path=str(ROOT/'Plumbing SLC'/'Reports'/'Codex'/f'021-viewer-loading-{width}.png'))
                    # The same in-flight load can cross the responsive boundary.
                    page.set_viewport_size({'width':390 if width>980 else 1440,'height':1000})
                    other='mobile-load-canvas' if width>980 else 'viewer-loading-canvas'
                    page.wait_for_function('id=>__arcadeTest.state().canvas===id',arg=other)
                    assert page.locator('#'+other).is_visible()
                    page.set_viewport_size({'width':width,'height':1000})
                    page.wait_for_function('id=>__arcadeTest.state().canvas===id',arg=canvas_id)
                page.evaluate('()=>{const r=window.__releaseArcadeIO;delete window.__releaseArcadeIO;r();}')
                page.wait_for_function('!__arcadeTest.state().loading')
                assert not canvas.is_visible()
                assert not page.locator('#viewer-loading-overlay').is_visible()
                ended=page.evaluate('()=>__arcadeTest.state()')
                assert ended['raf'] is None and not ended['scene'] and ended['textTimer'] is None,ended
                if kind=='failure': assert 'Could not load selected media' in page.locator('#status-text').inner_text()
                else:
                    page.wait_for_function("document.querySelector('#viewer-stage img')?.naturalWidth>0")
                    assert page.locator('.gallery-panel').is_visible()
                    assert '1 item' in page.locator('#gallery-count').inner_text()
                    if kind=='Open Files' and not reduced and width>980:
                        page.screenshot(path=str(ROOT/'Plumbing SLC'/'Reports'/'Codex'/'021-viewer-loaded-1440.png'))
                print(json.dumps({'viewport':width,'reduced':reduced,'path':kind,'result':'PASS'}),flush=True)
            assert not errors,errors
            context.close()
        browser.close()
finally:
    server.shutdown()

