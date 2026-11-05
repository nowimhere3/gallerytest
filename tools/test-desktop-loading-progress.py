"""Chromium integration: real 600-file provider batches, shared progress, no user profile."""
import os, sys, threading, http.server, socketserver, tempfile, base64, json
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.path.insert(0,str(Path(os.environ['TEMP'])/'pm-ui-playwright'))
    from playwright.sync_api import sync_playwright
class Quiet(http.server.SimpleHTTPRequestHandler):
    def __init__(self,*a,**k): super().__init__(*a,directory=str(ROOT),**k)
    def log_message(self,*a): pass
HOOKS='''
window.__progressTest={
 arm(kind) {
  window.__batches=[];
  const owner=kind==='known'?provider:fsaProvider;
  const key=kind==='known'?'loadFromFileList':'loadFromDirectoryHandle';
  const original=owner[key];
  owner[key]=async function(files,options){
   owner[key]=original;
   const callback=options.onProgress;
   const result=await original.call(this,files,{...options,onProgress:(loaded,total)=>{
    callback(loaded,total);
    window.__batches.push({loaded,total,
      phase:viewerLoadingPhase.textContent,count:viewerLoadingCount.textContent,
      bar:viewerLoadingBar.textContent,mobileBar:mobileLoadActivityBar.textContent,
      mobilePhase:mobileLoadPrimaryText.textContent,mobileCount:mobileLoadCountText.textContent,
      mobileCountHidden:mobileLoadCountText.classList.contains('hidden')});
   }});
   await new Promise(r=>window.__finishProvider=r);
   return result;
  };
 },
 state:()=>({loading:isLoadingFiles,raf:arcadeRafId,canvas:arcadeCanvas?.id})
};
'''
server=socketserver.ThreadingTCPServer(('127.0.0.1',0),Quiet)
threading.Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_address[1]}'
# One genuine small PNG copied under 600 distinct names.
png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')
try:
 with tempfile.TemporaryDirectory() as temp, sync_playwright() as pw:
  folder=Path(temp)/'progress';folder.mkdir()
  for i in range(600): (folder/f'picture-{i:03}.png').write_bytes(png)
  browser=pw.chromium.launch(executable_path=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',headless=True)
  for width,reduced in [(1440,False),(390,False),(1440,True),(390,True)]:
   context=browser.new_context(viewport={'width':width,'height':1000},reduced_motion='reduce' if reduced else 'no-preference')
   page=context.new_page();errors=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   page.route('**/src/main.js',lambda r:r.fulfill(status=200,content_type='text/javascript',body=(ROOT/'src/main.js').read_text(encoding='utf-8')+HOOKS))
   page.goto(base);page.wait_for_function('!!window.__progressTest')
   page.evaluate('''async data=>{
    const root=await navigator.storage.getDirectory();const dir=await root.getDirectoryHandle('progress-folder',{create:true});
    const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));
    for(let i=0;i<600;i++) { const f=await dir.getFileHandle('p-'+i+'.png',{create:true});const w=await f.createWritable();await w.write(bytes);await w.close(); }
    window.showDirectoryPicker=async()=>dir;
   }''',base64.b64encode(png).decode())
   for kind in ['known','unknown']:
    page.evaluate('kind=>__progressTest.arm(kind)',kind)
    if kind=='known': page.locator('#folder-input').set_input_files(str(folder))
    else: page.locator('#fsa-choose-folder-btn').dispatch_event('click')
    page.wait_for_function('!!window.__finishProvider')
    batches=page.evaluate('window.__batches')
    assert [b['loaded'] for b in batches]==[250,500,600],batches
    for b in batches:
     assert b['phase']==b['mobilePhase'] and b['bar']==b['mobileBar'],b
     assert len(b['bar'])==12,b
     if kind=='known':
      assert b['count']==f"{b['loaded']} / 600 media files" and b['mobileCount']==b['count'],b
      assert b['bar'].count('▓')==int(b['loaded']/600*10+0.5),b
      assert not b['mobileCountHidden'],b
     else:
      assert b['phase']=='Scanning folder…',b
      assert b['count']==f"{b['loaded']} media files found so far",b
      assert b['mobileCountHidden'] and b['mobileCount']=='',b
      assert b['bar'].count(chr(0x2593))==3, 'unknown total must use sweep, never stale full ratio'
    canvas=page.locator('#viewer-loading-canvas' if width>980 else '#mobile-load-canvas')
    assert canvas.is_visible()
    page.wait_for_function('''id=>document.getElementById(id).getContext('2d').getImageData(0,0,160,64).data.some((v,i)=>i%4!==3&&v>30)''',arg=canvas.get_attribute('id'))
    if width>980:
     assert canvas.bounding_box()['width']==480
     panel=page.locator('#viewer-panel').bounding_box();box=canvas.bounding_box()
     assert box['y']>=panel['y'] and box['y']+box['height']<=panel['y']+panel['height']+1,(box,panel)
     assert page.locator('.gallery-panel').is_visible()
     assert page.locator('#viewer-loading-phase').is_visible()
    else: assert not page.locator('#viewer-loading-overlay').is_visible()
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    if not reduced:
     page.screenshot(path=str(ROOT/'Plumbing SLC'/'Reports'/'Codex'/f'022-progress-{width}-{kind}.png'))
    page.evaluate('()=>{const r=__finishProvider;delete window.__finishProvider;r();}')
    page.wait_for_function('!__progressTest.state().loading')
    assert not page.locator('#viewer-loading-overlay').is_visible()
    assert page.evaluate('__progressTest.state().raf===null')
    print(json.dumps({'width':width,'reduced':reduced,'kind':kind,'batches':[b['count'] for b in batches],'result':'PASS'}),flush=True)
   # No I/O gate for this load: completion must require no test release/minimum dwell.
   page.locator('#file-input').set_input_files(str(folder/'picture-000.png'))
   page.wait_for_function("!__progressTest.state().loading && document.querySelector('#status-text').textContent==='Media loaded'")
   assert not page.locator('#viewer-loading-overlay').is_visible()
   assert not errors,errors
   context.close()
  browser.close()
finally: server.shutdown()
