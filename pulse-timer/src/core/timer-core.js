(() => {
  'use strict';

  function buildPhases(workout) {
    const w=workout||{};
    const out=[];

    if(Number(w.prep)>0){
      out.push({label:'ПОДГОТОВКА',duration:Number(w.prep),type:'prep',set:1,cycle:0});
    }

    const sets=Math.max(1,Number(w.sets)||1);
    const cycles=Math.max(1,Number(w.cycles)||1);
    const work=Math.max(1,Number(w.work)||1);
    const rest=Math.max(0,Number(w.rest)||0);
    const setRest=Math.max(0,Number(w.setRest)||0);
    const coolDown=Math.max(0,Number(w.coolDown)||0);

    for(let set=1;set<=sets;set+=1){
      for(let cycle=1;cycle<=cycles;cycle+=1){
        out.push({label:'РАБОТА',duration:work,type:'work',set,cycle});
        if(cycle<cycles&&rest>0){
          out.push({label:'ОТДЫХ',duration:rest,type:'rest',set,cycle});
        }
      }
      if(set<sets&&setRest>0){
        out.push({
          label:'ОТДЫХ МЕЖДУ ПОДХОДАМИ',
          duration:setRest,
          type:'rest',
          set,
          cycle:cycles
        });
      }
    }

    if(coolDown>0){
      out.push({label:'ЗАМИНКА',duration:coolDown,type:'rest',set:sets,cycle:cycles});
    }

    return out;
  }

  function totalSeconds(workout) {
    return buildPhases(workout).reduce((sum,phase)=>sum+phase.duration,0);
  }

  window.PulseTimerCore=Object.freeze({buildPhases,totalSeconds});
})();
