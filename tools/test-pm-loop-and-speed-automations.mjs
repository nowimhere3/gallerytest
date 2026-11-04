import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {installFakeIndexedDB} from './lib/browser-test-env.mjs';
import {loadPreferences,savePresentationPreferences} from '../src/storage/app-preferences.js';
const source=fs.readFileSync(new URL('../src/main.js',import.meta.url),'utf8');
const timers=new Map();let id=0,advances=0;
const c={activeLoopRule:{type:'times',totalPlays:2},activeSpeedRule:{rate:1,scope:'current'},libraryLoadGeneration:1,loopRuleCompletedPlays:0,loopRuleVideoToken:0,loopRuleTimerId:null,videoLoopInput:{checked:true},currentViewerNode:{tagName:'VIDEO'},runtime:{notifyVideoEnded(){advances++;}},window:{setTimeout(fn){timers.set(++id,fn);return id;},clearTimeout(id){timers.delete(id);}},syncVideoLoopControl(){if(!c.videoLoopInput.checked){c.activeLoopRule={type:'forever'};c.loopRuleCompletedPlays=0;c.clearLoopRuleTimer();}},closeAutomationsTray(){},tsPlaybackAdapter:{detach(){}},hlsPlaybackAdapter:{detach(){}},viewerStage:{innerHTML:''},currentViewerItem:null};
vm.createContext(c);
for(const n of ['normalizeAutomationSpeed','isFolderScopedLoopRule','applyAutomationSpeed','clearLoopRuleTimer','applyLoopRuleToCurrentVideo','armLoopRuleForCurrentVideo','shouldLoopRuleRestartVideo','completeFiniteLoopAutomationAndAdvance','handleManualNavigationLoopReset','invalidateActiveFiniteAutomation','stopAllPresentationAutomations']){
 const start=source.indexOf('function '+n+'(');const end=source.indexOf('\n}',start)+2;vm.runInContext(source.slice(start,end),c);
}
assert(c.shouldLoopRuleRestartVideo());assert(!c.shouldLoopRuleRestartVideo());c.completeFiniteLoopAutomationAndAdvance();assert.equal(advances,1);assert.equal(c.videoLoopInput.checked,false);
c.videoLoopInput.checked=true;c.activeLoopRule={type:'timer',minutes:0,seconds:30};c.armLoopRuleForCurrentVideo();[...timers.values()][0]();assert.equal(advances,2);assert.equal(c.videoLoopInput.checked,false);
for(const type of ['times','timer']){
 c.videoLoopInput.checked=true;c.activeLoopRule={type,scope:'folder',generation:1,totalPlays:2,minutes:0,seconds:30};
 c.armLoopRuleForCurrentVideo();const token=c.loopRuleVideoToken;c.handleManualNavigationLoopReset();assert.equal(c.activeLoopRule.type,type);
 c.completeFiniteLoopAutomationAndAdvance();assert.equal(c.videoLoopInput.checked,true);assert.equal(c.activeLoopRule.type,type);
 c.currentViewerNode={tagName:'IMG'};c.applyLoopRuleToCurrentVideo();assert.equal(c.loopRuleTimerId,null);assert.equal(c.activeLoopRule.type,type);
 c.currentViewerNode={tagName:'VIDEO'};c.armLoopRuleForCurrentVideo();assert(c.loopRuleVideoToken>token);assert.equal(c.loopRuleCompletedPlays,0);
 if(type==='timer')assert.notEqual(c.loopRuleTimerId,null);
}
c.activeSpeedRule={rate:0.30000000000000004,scope:'folder',generation:1};c.applyAutomationSpeed(c.currentViewerNode);assert.equal(c.currentViewerNode.playbackRate,.3);assert.equal(c.currentViewerNode.defaultPlaybackRate,.3);assert.equal(c.activeLoopRule.type,'timer');
c.stopAllPresentationAutomations();assert.equal(c.activeSpeedRule.rate,1);assert.equal(c.videoLoopInput.checked,false);assert.equal(c.loopRuleTimerId,null);
c.activeSpeedRule={rate:.4,scope:'folder',generation:1};c.libraryLoadGeneration=2;c.applyAutomationSpeed(c.currentViewerNode);assert.equal(c.currentViewerNode.playbackRate,1);
assert(source.includes('if (activeSpeedRule.scope !== "folder") activeSpeedRule = {rate:1,scope:"current"}'));
assert(source.slice(source.indexOf('function exitFillMode()'),source.indexOf('function exitFillMode()')+2400).includes('stopAllPresentationAutomations()'));
installFakeIndexedDB();await savePresentationPreferences({loopTimes:2,timerMinutes:0,timerSeconds:30,playbackSpeed:.4});const prefs=await loadPreferences();assert.equal(prefs.presentation.loopTimes,2);assert.equal(prefs.presentation.timerSeconds,30);assert.equal(prefs.presentation.playbackSpeed,.4);assert(!('scope' in prefs.presentation));
assert(source.includes('let activeSpeedRule = { rate: 1, scope: "current" }'));assert.equal(c.normalizeAutomationSpeed(1),1);
console.log('PASS loop/speed current and folder lifecycle, composition, generation, master stop, preferences and normalization');

// Actual editor entry and ended callback: configuring a short video is protected.
const clickNode=()=>({addEventListener(_,fn){this.click=fn;}});
c.overlayAutomationBtn=clickNode();c.presentationSettings={classList:{add(){}}};c.closeGhostPopunder=()=>{};
c.automationPanel={classList:{contains:()=>true}};c.openAutomationEditor=()=>{};c.closeAutomationEditor=()=>{};
c.videoLoopInput.checked=false;c.syncVideoLoopControl=()=>c.applyLoopRuleToCurrentVideo();
let from=source.indexOf('overlayAutomationBtn.addEventListener("click",');let to=source.indexOf('\n});',from)+4;
vm.runInContext(source.slice(from,to),c);c.overlayAutomationBtn.click();assert(c.videoLoopInput.checked);assert.equal(c.activeLoopRule.type,'forever');
let replayCount=0,ended;
c.video={currentTime:5,addEventListener(_,fn){ended=fn;}};c.currentViewerNode=c.video;c.fillModeActive=true;c.runtime.getState=()=>({isPlaying:true});c.playViewerVideo=()=>replayCount++;
from=source.indexOf('    video.addEventListener("ended",',source.indexOf('const loopRuleToken = armLoopRuleForCurrentVideo();'));to=source.indexOf('\n    });',from)+7;
vm.runInContext('const loopRuleToken = loopRuleVideoToken;'+source.slice(from,to),c);
const before=advances;ended();ended();ended();assert.equal(replayCount,3);assert.equal(advances,before);
for(const mode of ['times','timer']){
 const key=mode==='times'?'automationTimesApplyBtn':'automationTimerApplyBtn';c[key]=clickNode();
 c.automationTimesFolder=c.automationTimerFolder={checked:false};c.automationDraftTotalPlays=2;c.automationDraftMinutes=0;c.automationDraftSeconds=26;c.rememberAutomationValues=()=>{};
 from=source.indexOf(key+'.addEventListener("click",');to=source.indexOf('\n});',from)+4;vm.runInContext(source.slice(from,to),c);c[key].click();assert.equal(c.activeLoopRule.type,mode);
}
for(let seconds=0;seconds<60;seconds++){
 await savePresentationPreferences({timerSeconds:seconds});assert.equal((await loadPreferences()).presentation.timerSeconds,seconds);
}
for(const rate of [.26,.35,.41,.42,.57,.83]){
 assert.equal(c.normalizeAutomationSpeed(rate),rate);await savePresentationPreferences({playbackSpeed:rate});assert.equal((await loadPreferences()).presentation.playbackSpeed,rate);
}
assert.equal(c.normalizeAutomationSpeed(.1+.16),.26);
await savePresentationPreferences({timerMinutes:0,timerSeconds:26});assert.equal((await loadPreferences()).presentation.timerSeconds,26);
console.log('PASS editing loop protection, repeated ended replay, finite Apply replacement, all 60 seconds, precise saved speed');
