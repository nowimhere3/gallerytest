"""Isolated Chromium intake integration. Never opens the user's browser profile.
Requires Playwright (or %TEMP%/pm-ui-playwright) and installed Microsoft Edge.
Picker selection is emulated by returning genuine cloneable OPFS handles.
"""
import os, sys, threading, http.server, socketserver, tempfile, shutil, json, subprocess
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.path.insert(0, str(Path(os.environ['TEMP']) / 'pm-ui-playwright'))
    from playwright.sync_api import sync_playwright

class Quiet(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)
    def log_message(self, *args):
        pass

server = socketserver.ThreadingTCPServer(('127.0.0.1', 0), Quiet)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_address[1]}'
results = []
with tempfile.TemporaryDirectory(prefix='gallery-intake-fixtures-') as fixture:
    folder = Path(fixture) / 'pictures'
    folder.mkdir()
    image = folder / 'test-image.png'
    shutil.copyfile(ROOT / 'NEW-redesign-Winner So far.png', image)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe', headless=True)
        context = browser.new_context()
        page = context.new_page()
        errors, logs = [], []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: logs.append(m.type + ': ' + m.text))
        baseline = '--baseline' in sys.argv
        if baseline:
            old_main = subprocess.check_output(['git','show','7db735ae4f3adf708ae6791f20901f04c7769360:src/main.js'], cwd=ROOT)
            page.route('**/src/main.js', lambda route: route.fulfill(status=200, content_type='text/javascript', body=old_main))
        if '--committed-sync' in sys.argv:
            # Exercise the intake repair independently of unrelated Sync WIP.
            for module in ['profile-sync.js', 'sync-v3-transport.js', 'sync-v3-write-policy.js']:
                committed = subprocess.check_output([
                    'git', 'show',
                    '7db735ae4f3adf708ae6791f20901f04c7769360:src/profile/' + module,
                ], cwd=ROOT)
                page.route('**/src/profile/' + module,
                    (lambda body: lambda route: route.fulfill(status=200, content_type='text/javascript', body=body))(committed))
        page.goto(base)
        page.wait_for_function("typeof window.__bgProfileIdentityAudit === 'function'")
        page.evaluate('''async (base) => {
          const root = await navigator.storage.getDirectory();
          const dir = await root.getDirectoryHandle('intake-pictures', {create:true});
          const fh = await dir.getFileHandle('remembered-image.png', {create:true});
          const w = await fh.createWritable();
          await w.write(await (await fetch(base + '/NEW-redesign-Winner%20So%20far.png')).blob());
          await w.close();
          const floppy = await root.getFileHandle('intake-links.txt', {create:true});
          const fw = await floppy.createWritable();
          await fw.write(base + '/NEW-redesign-Winner%20So%20far.png'); await fw.close();
          window.__intakeDir = dir;
          window.showDirectoryPicker = async () => dir;
          window.showOpenFilePicker = async () => [floppy];
        }''', base)

        def snapshot(label):
            state = page.evaluate('''() => ({
                status: document.querySelector('#status-text').textContent,
                fsa: document.querySelector('#fsa-status-text').textContent,
                remote: document.querySelector('#remote-status-text').textContent,
                images: document.querySelectorAll('#viewer-stage img').length,
                saved: document.querySelector('#fsa-recent-libraries').textContent,
                active: document.querySelector('#profile-select').value,
                primary: document.querySelector('#profile-primary-select').value
            })''')
            state.update(label=label, pageErrors=list(errors), recentConsole=logs[-6:])
            print(json.dumps(state), flush=True)
            results.append(state)
            return state

        last_source = [None]

        def expect_loaded(label):
            try:
                page.wait_for_function("old => {const img=document.querySelector('#viewer-stage img');return img && img.complete && img.naturalWidth > 0 && (!old || img.src !== old);}",arg=last_source[0],timeout=7000)
            except Exception:
                snapshot(label)
                raise
            last_source[0] = page.locator('#viewer-stage img').get_attribute('src')
            state = snapshot(label)
            assert state['status'] == 'Media loaded', state
            assert not errors, errors

        page.locator('#file-input').set_input_files(str(image))
        expect_loaded('A Open Files')
        # Distinct filename/viewer assertion ensures each intake really replaces prior media.
        page.locator('#folder-input').set_input_files(str(folder))
        expect_loaded('B Open Folder')
        page.locator('#cassette-add-btn').click()
        page.wait_for_function("document.querySelector('#remote-status-text').textContent.includes('ready')", timeout=7000)
        expect_loaded('C Remember File valid Floppy')
        page.locator('#fsa-choose-folder-btn').click()
        page.wait_for_function("document.querySelector('#fsa-status-text').textContent.includes('Loaded')", timeout=7000)
        expect_loaded('D Remember Folder')
        # Use Saved Libraries' actual reopen button.
        remembered = page.locator('#fsa-recent-libraries .fsa-recent-library-btn').filter(has_text='intake-pictures')
        remembered.click()
        page.wait_for_timeout(250)
        expect_loaded('E Saved Library reopen')

        # An actual current-source Save authors the association used by restoration.
        original = page.locator('#profile-select').input_value()
        page.locator('#profile-associate-btn').dispatch_event('click')
        page.locator('#profile-association-select').evaluate('(e,id)=>e.value=id', original)
        page.locator('#profile-association-save-btn').dispatch_event('click')
        page.wait_for_function("document.querySelector('#profile-association-result').textContent.includes('Now remembered')")
        page.evaluate("""() => {
          const get = IDBObjectStore.prototype.get;
          window.__heldAmbient = [];
          window.__stallAmbient = true;
          IDBObjectStore.prototype.get = function(key) {
            const actual = get.call(this, key);
            if (this.name !== 'ambient-profile-decisions' || !window.__stallAmbient) return actual;
            const held = {get result() {return actual.result;}};
            window.__heldAmbient.push(held);
            return held; // delay only application completion of this metadata read
          };
        }""")
        before_stall = page.locator('#viewer-stage img').get_attribute('src')
        page.locator('#fsa-choose-folder-btn').click()
        page.wait_for_function('window.__heldAmbient.length > 0')
        if baseline:
            page.wait_for_timeout(2600)
            assert page.locator('#viewer-stage img').get_attribute('src') == before_stall
            page.locator('#file-input').set_input_files(str(image))
            page.wait_for_timeout(250)
            assert page.locator('#viewer-stage img').get_attribute('src') == before_stall
            snapshot('BASELINE REPRO: pending pre-scan decision wedges FSA and next Open Files')
            browser.close()
            server.shutdown()
            raise SystemExit(0)
        page.wait_for_function('(old)=>document.querySelector("#viewer-stage img")?.src !== old && !!document.querySelector("#viewer-stage img")', arg=before_stall, timeout=7000)
        page.wait_for_function("document.querySelector('#fsa-status-text').textContent.includes('Curation setup could not finish')")
        expect_loaded('H pending Curation read times out and media still loads')
        current = page.locator('#profile-select').input_value()
        page.evaluate('() => {window.__stallAmbient=false; for(const held of window.__heldAmbient) held.onsuccess?.();}')
        page.wait_for_timeout(150)
        assert page.locator('#profile-select').input_value() == current
        page.locator('#file-input').set_input_files(str(image))
        page.wait_for_timeout(250)
        expect_loaded('G subsequent Open Files after stalled metadata works')

        # Configure Primary through the app's existing UI, then select another local Curation.
        original = page.locator('#profile-select').input_value()
        page.locator('#profile-create-input').evaluate("e=>e.value='Intake Primary'")
        page.locator('#profile-create-btn').dispatch_event('click')
        page.wait_for_timeout(800)
        page.wait_for_function("document.querySelector('#profile-active-status-text').textContent.includes('Created and switched')", timeout=3000)
        target = page.locator('#profile-select').input_value()
        page.locator('#profile-primary-select').evaluate('(e,id)=>e.value=id', target)
        page.locator('#profile-primary-save-btn').dispatch_event('click')
        page.wait_for_function("document.querySelector('#profile-primary-status-text').textContent.includes('saved')")
        page.locator('#profile-select').evaluate("(e,id)=>{e.value=id;e.dispatchEvent(new Event('change'));}", original)
        page.wait_for_function('(id)=>document.querySelector("#profile-select").value===id', arg=original)
        page.locator('#fsa-choose-folder-btn').click()
        page.wait_for_timeout(300)
        expect_loaded('L explicit source Curation outranks Primary')
        assert page.locator('#profile-select').input_value() == original
        page.evaluate("""async () => {
          const root=await navigator.storage.getDirectory();
          const dir=await root.getDirectoryHandle('primary-fallback',{create:true});
          const source=await (await window.__intakeDir.getFileHandle('remembered-image.png')).getFile();
          const file=await dir.getFileHandle('fresh-primary.png',{create:true});
          const w=await file.createWritable();await w.write(source);await w.close();
          window.showDirectoryPicker=async()=>dir;
        }""")
        page.locator('#fsa-choose-folder-btn').click()
        page.wait_for_function('(id)=>document.querySelector("#profile-select").value===id',arg=target)
        expect_loaded('K live Primary applies to unassigned folder')
        page.locator('#profile-associate-btn').dispatch_event('click')
        page.locator('#profile-association-select').evaluate('e=>e.value=""')
        page.locator('#profile-association-save-btn').dispatch_event('click')
        page.wait_for_function("document.querySelector('#profile-association-result').textContent.includes('No Curation')")
        page.locator('#profile-select').evaluate("(e,id)=>{e.value=id;e.dispatchEvent(new Event('change'));}",original)
        page.wait_for_function("document.querySelector('#associated-text').textContent.includes('My Gallery')")
        page.locator('#fsa-choose-folder-btn').click()
        page.wait_for_timeout(300)
        expect_loaded('M explicit No Curation blocks Primary')
        assert page.locator('#profile-select').input_value() == original
        # Failed picker then successful retry, without cleaning application state.
        page.evaluate("() => {window.showDirectoryPicker=async()=>{throw new Error('intentional picker failure')};}")
        page.locator('#fsa-choose-folder-btn').click()
        page.wait_for_function("document.querySelector('#fsa-status-text').textContent.includes('Could not open')")
        page.evaluate("() => {window.showDirectoryPicker=async()=>window.__intakeDir;}")
        page.locator('#fsa-choose-folder-btn').click()
        page.wait_for_function("document.querySelector('#fsa-status-text').textContent.includes('Loaded')")
        expect_loaded('G/O visible failure then successful retry')
        # A synchronous setup exception after the loader owns its busy flag.
        page.evaluate("""() => {
          const list=document.querySelector('#automation-step-speed').classList;
          const toggle=list.toggle.bind(list);
          list.toggle=function(...args){list.toggle=toggle;throw new Error('intentional intake setup failure');};
        }""")
        page.locator('#fsa-choose-folder-btn').click()
        page.wait_for_function("document.querySelector('#fsa-status-text').textContent.includes('intentional intake setup failure')")
        snapshot('O synchronous loader setup exception is visible')
        page.locator('#file-input').set_input_files(str(image))
        expect_loaded('G subsequent intake after setup exception works')
        # Registry persistence can stall before loadFromFsaHandle is called.
        # Unknown row identity must preserve the active Curation, not guess Primary.
        page.locator('#profile-select').evaluate("(e,id)=>{e.value=id;e.dispatchEvent(new Event('change'));}", original)
        page.wait_for_function("document.querySelector('#associated-text').textContent.includes('My Gallery')")
        page.evaluate("""() => {
          const getAll = IDBObjectStore.prototype.getAll;
          window.__nativeGetAll = getAll;
          window.__heldLibraries = [];
          IDBObjectStore.prototype.getAll = function(...args) {
            const actual = getAll.apply(this,args);
            if (this.transaction.db.name !== 'loop-browser-gallery-fsa' || this.name !== 'libraries') return actual;
            const held={get result(){return actual.result;}};
            window.__heldLibraries.push(held);
            return held;
          };
        }""")
        page.locator('#fsa-choose-folder-btn').click()
        page.wait_for_function('window.__heldLibraries.length > 0')
        page.wait_for_function("document.querySelector('#fsa-status-text').textContent.includes('Could not finish remembering')", timeout=7000)
        expect_loaded('H pre-loader registry stall falls back to session loading')
        assert page.locator('#profile-select').input_value() == original, 'unknown registry must not guess Primary'
        page.evaluate("() => { IDBObjectStore.prototype.getAll = window.__nativeGetAll; }")
        page.locator('#file-input').set_input_files(str(image))
        expect_loaded('G subsequent Open Files after registry stall works')


        browser.close()
server.shutdown()
