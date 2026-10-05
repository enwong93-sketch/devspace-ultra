import {ClassicCdpClient} from './classic-cdp-client.js';
import {nativeConversationResponseReceipt} from './native-conversation-response-receipt.js';

// Observe the client's existing successful API replies. Never induce another
// native conversation fetch just to compete with its existing reader.
export async function observeNativeMaintenance(scope, {
  clientFactory = url=>new ClassicCdpClient(url,{callTimeoutMs:5000}),
  timeoutMs=180_000, now=Date.now,
}={}) {
  const client=clientFactory(scope.pageWebSocketDebuggerUrl),requests=new Map(),seen=new Set();
  const samples=[];let timer,settled=false,finish;
  const done=new Promise(resolve=>{finish=result=>{if(!settled){settled=true;resolve(result);}}});
  const fail=reason=>finish({ready:false,reason});
  const path='/backend-api/conversation/'+scope.conversationId;
  try {
    await client.open();
    client.on('Page.frameNavigated',p=>{
      if(p.frame?.id===scope.pageTargetId)fail('native-page-navigation-during-observation');
    });
    client.on('Page.navigatedWithinDocument',p=>{
      if(p.frameId===scope.pageTargetId)fail('native-page-navigation-during-observation');
    });
    client.on('Network.requestWillBeSent',p=>{
      let url;try{url=new URL(p.request?.url)}catch{return}
      if(url.hostname!=='chatgpt.com')return;
      if(p.request.method==='POST'&&/^\/backend-api\/(?:f\/)?conversation(?:\/|$)/.test(url.pathname)) {
        fail('new-native-request-during-maintenance');return;
      }
      if(p.request.method!=='GET'||url.pathname!==path||p.frameId!==scope.pageTargetId
        ||!Number.isFinite(p.wallTime))return;
      requests.set(p.requestId,{startedAtMs:p.wallTime*1000,status:null,cached:false});
    });
    client.on('Network.requestServedFromCache',p=>{const r=requests.get(p.requestId);if(r)r.cached=true});
    client.on('Network.responseReceived',p=>{
      const r=requests.get(p.requestId);if(!r)return;
      r.status=p.response?.status;
      r.cached ||= !!(p.response?.fromDiskCache||p.response?.fromServiceWorker||p.response?.fromPrefetchCache);
    });
    client.on('Network.loadingFinished',p=>{
      const r=requests.get(p.requestId);
      if(settled||!r||seen.has(p.requestId)||r.status!==200||r.cached)return;
      seen.add(p.requestId);
      void (async()=>{
        try {
          const raw=await client.call('Network.getResponseBody',{requestId:p.requestId});
          if(settled)return;
          const body=raw.base64Encoded?Buffer.from(raw.body,'base64').toString('utf8'):raw.body;
          if(typeof body!=='string'||Buffer.byteLength(body)>8*1024*1024){fail('native-response-exceeds-bound');return;}
          const receipt=nativeConversationResponseReceipt(JSON.parse(body),scope,
            {readStartedAtMs:r.startedAtMs,observedAtMs:now()});
          if(!receipt){fail('native-response-not-current-completed-final');return;}
          const previous=samples.at(-1);
          if(previous) {
            if(receipt.readStartedAtMs<=previous.observedAtMs)return;
            if(['assistantMessageId','sourceUserMessageId','assistantTextHash','assistantCreatedAt']
              .some(k=>receipt[k]!==previous[k])){fail('native-current-final-changed');return;}
          }
          samples.push(receipt);
          if(samples.length===2)finish({ready:true,receipt,samples:2,source:'observed-existing-native-api-replies',
            observedAtMs:now(),nativeFetchesInduced:0});
        }catch{fail('native-response-observation-unavailable');}
      })();
    });
    timer=setTimeout(()=>fail('no-two-fresh-native-successful-replies'),Math.max(1000,Math.min(180_000,timeoutMs)));
    await client.call('Page.enable');
    await client.call('Network.enable');
    return await done;
  }catch{return {ready:false,reason:'native-observer-connection-unavailable'};}
  finally{if(timer)clearTimeout(timer);client.close();}
}
