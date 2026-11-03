import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {mapAssociationCopy,shouldShowActiveCurationChoice} from '../src/profile/association-copy.js';
const main=fs.readFileSync(new URL('../src/main.js',import.meta.url),'utf8');
function node(){const classes=new Set(['hidden']);return {textContent:'',value:'',classList:{contains:x=>classes.has(x),add:x=>classes.add(x),remove:x=>classes.delete(x),toggle(x,on){if(on)classes.add(x);else classes.delete(x);}},setAttribute(){},focus(){},appendChild(){},addEventListener(type,fn){this[type]=fn;}};}
let input={sourceKind:'fsa',activeProfileId:'beast',activeProfileName:'BEAST',primaryProfileId:'beast',primaryProfileName:'BEAST'};
const c={getCurrentAssociationUiState:()=>mapAssociationCopy(input),shouldShowActiveCurationChoice,applyProductStatusTone(){},associationHelpKey:()=>'',dismissedAssociationHelpKey:null,syncMobileContextSummary(){},renderFolderLinkState(){},displayCurationLabel:p=>p.name,profile:{getProfileId:()=>input.activeProfileId,listProfiles:()=>[{id:'beast',name:'BEAST'},{id:'family',name:'Family'}]},document:{createElement:()=>node()}};
for(const name of ['associatedText','profileLibraryAssociationText','profileMediaSource','profileActiveGroup','fsaAssociateBtn','profileAssociateBtn','fsaAssociateBtnLabel','profileAssociationRow','fsaAssociateHelp','profileAssociationSelect','profileAssociationResult']) c[name]=node();
vm.createContext(c);
for(const name of ['updateAssociatedStatusRow','syncAssociateButtonVisibility','populateAssociationPicker','openAssociationEditor','closeAssociationEditor']){
 const start=main.indexOf('function '+name+'(');const end=main.indexOf('\n}',start)+2;
 vm.runInContext(main.slice(start,end),c);
}
const start=main.indexOf('profileAssociateBtn.addEventListener("click",');const end=main.indexOf('profileAssociationSaveBtn.addEventListener(',start);
vm.runInContext(main.slice(start,end),c);
c.syncAssociateButtonVisibility();
assert.equal(c.profileLibraryAssociationText.textContent,'Using Primary: BEAST');
assert.equal(c.profileAssociateBtn.textContent,'Use a different Curation');
assert.equal(c.fsaAssociateBtnLabel.textContent,'Use a different Curation');
c.profileAssociateBtn.click();assert.equal(c.profileAssociationRow.classList.contains('hidden'),false,'same source chooser opens');
assert.equal(c.profileAssociationSelect.value,'beast','existing picker defaults to active Primary');
input={...input,associatedProfileId:'family',associatedProfileName:'Family',activeProfileId:'family',activeProfileName:'Family',hasExplicitSourceChoice:true};
c.syncAssociateButtonVisibility();assert.equal(c.associatedText.textContent,'Family');assert(!c.profileLibraryAssociationText.textContent.includes('Using Primary'));
input={...input,associatedProfileId:null,associatedProfileName:null,hasExplicitSourceChoice:true,activeProfileId:'beast'};
c.syncAssociateButtonVisibility();assert(!c.profileLibraryAssociationText.textContent.includes('Using Primary'));
console.log('PASS live Settings/rail rendering and existing source chooser override');
