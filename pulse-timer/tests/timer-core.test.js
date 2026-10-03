const fs=require('fs');
const path=require('path');
const vm=require('vm');

const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'src/core/timer-core.js'),'utf8');
const sandbox={window:{}};
vm.createContext(sandbox);
vm.runInContext(source,sandbox);

const core=sandbox.window.PulseTimerCore;
if(!core)throw new Error('PulseTimerCore not exported');

const assert=(condition,message)=>{if(!condition)throw new Error(message)};

const simple={prep:3,work:30,rest:10,cycles:3,sets:1,setRest:0,coolDown:5};
const phases=core.buildPhases(simple);
assert(phases.length===7,'Unexpected simple phase count: '+phases.length);
assert(phases[0].type==='prep'&&phases[0].duration===3,'Preparation phase incorrect');
assert(phases.filter(p=>p.type==='work').length===3,'Work phase count incorrect');
assert(phases.filter(p=>p.type==='rest').length===3,'Rest/cooldown phase count incorrect');
assert(phases.at(-1).label==='ЗАМИНКА','Cooldown phase missing');
assert(core.totalSeconds(simple)===118,'Simple workout total incorrect');

const sets={prep:0,work:20,rest:5,cycles:2,sets:3,setRest:40,coolDown:0};
const setPhases=core.buildPhases(sets);
assert(setPhases.filter(p=>p.type==='work').length===6,'Multi-set work count incorrect');
assert(setPhases.filter(p=>p.label==='ОТДЫХ МЕЖДУ ПОДХОДАМИ').length===2,'Set-rest count incorrect');
assert(core.totalSeconds(sets)===215,'Multi-set total incorrect');

const minimum=core.buildPhases({work:1,cycles:1,sets:1});
assert(minimum.length===1&&minimum[0].type==='work','Minimum workout must contain exactly one work phase');
assert(minimum[0].duration===1,'Minimum work duration incorrect');

console.log('Pulse Timer core test: PASS');
