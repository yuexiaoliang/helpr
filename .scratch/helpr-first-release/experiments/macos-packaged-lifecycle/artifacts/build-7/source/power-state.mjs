// Independent OS pause reasons survive overlapping sleep/lock notifications.
// A successful observation can release only the pause generation it checked.
export function createPowerGate({revoke,reconcile,changed}){
  const reasons=new Set();let blocked=false,revision=0,checking=null;
  async function releaseWhenClear(){
    while(blocked&&reasons.size===0){
      if(!checking){
        const observedRevision=revision;
        checking=(async()=>{
          await reconcile();
          if(revision===observedRevision&&reasons.size===0){blocked=false;changed(false);}
        })().finally(()=>{checking=null;});
      }
      await checking;
    }
  }
  return {
    snapshot:()=>({blocked,reasons:[...reasons],checking:checking!==null,revision}),
    async event(event){
      const pause=event==='suspend'?'sleep':event==='lock-screen'?'lock':null;
      if(pause){reasons.add(pause);revision++;blocked=true;changed(true);revoke();return;}
      const clear=event==='resume'?'sleep':event==='unlock-screen'?'lock':null;
      if(!clear)return;
      reasons.delete(clear);
      await releaseWhenClear();
    }
  };
}
