// Smoke 35-tool surface. Sandbox subfolder for writes.
import { spawn } from 'node:child_process';
const child = spawn('/opt/homebrew/opt/node@22/bin/node', ['/Users/rogerfrench/vaultnexus/dist/bridge/main.js'], { stdio: ['pipe','pipe','inherit'] });
let buf=''; const p=new Map();
child.stdout.on('data',(b)=>{buf+=b.toString();let i;while((i=buf.indexOf('\n'))>=0){const l=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!l)continue;try{const m=JSON.parse(l);const cb=p.get(m.id);if(cb){p.delete(m.id);cb(m);}}catch{}}});
let id=1; const rpc=(method,params)=>new Promise((res)=>{const my=id++;p.set(my,res);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:my,method,params})+'\n');setTimeout(()=>{if(p.has(my)){p.delete(my);res({error:{message:'timeout'}});}},30000);});
const call=(n,a)=>rpc('tools/call',{name:n,arguments:a});
const ok=(r)=>!r.error&&!r.result?.isError;
const sz=(r)=>{if(r.error)return`RPC:${r.error.message}`;const c=r.result?.content?.[0];if(r.result?.isError)return`TOOL:${c?.text?.slice(0,80)}`;return`${(c?.text??'').length}b`;};
let pass=0,fail=0;const tlog=(label,r)=>{const o=ok(r);console.log(`${o?'✓':'✗'} ${label.padEnd(34)} ${sz(r)}`);if(o)pass++;else fail++;};

await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'smoke35',version:'0'}});
child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
const tl=await rpc('tools/list'); console.log(`tools/list → ${tl.result?.tools?.length} tools\n`);

const SB='_vn35';

// Reads first → no state churn
tlog('ping',                 await call('vaultnexus_ping',{}));
tlog('list',                 await call('vaultnexus_list',{}));
tlog('stats',                await call('vaultnexus_stats',{}));
tlog('tags',                 await call('vaultnexus_tags',{limit:3}));
tlog('recent',               await call('vaultnexus_recent',{limit:3}));
tlog('orphans',              await call('vaultnexus_orphans',{}));
tlog('broken_links',         await call('vaultnexus_broken_links',{}));
tlog('search',               await call('vaultnexus_search',{query:'a',k:2}));
tlog('bridges',              await call('vaultnexus_bridges',{topN:2}));
tlog('find_by_tag',          await call('vaultnexus_find_by_tag',{tag:'idea'}));

const lr=await call('vaultnexus_list',{});
const first=JSON.parse(lr.result.content[0].text).notes?.[0];
if (first) {
  tlog('read_page',          await call('vaultnexus_read_page',{notePath:first,byteStart:0,byteEnd:200}));
  tlog('outline',            await call('vaultnexus_outline',{notePath:first}));
  tlog('link_graph',         await call('vaultnexus_link_graph',{notePath:first}));
  tlog('neighbors',          await call('vaultnexus_neighbors',{notePath:first,k:3}));
  tlog('get_partial:outline',await call('vaultnexus_get_partial',{notePath:first,kind:'outline'}));
  tlog('get_partial:fm',     await call('vaultnexus_get_partial',{notePath:first,kind:'frontmatter'}));
}

// Writes — sandbox
tlog('create_folder',        await call('vaultnexus_create_folder',{folderPath:SB}));
tlog('create_page',          await call('vaultnexus_create_page',{notePath:`${SB}/hi.md`,content:'# hi\n\n## sub\n\nbody\n'}));
tlog('append',               await call('vaultnexus_append_to_page',{notePath:`${SB}/hi.md`,text:'\n\n## extras\n\nextra body\n'}));
tlog('insert_after_heading', await call('vaultnexus_insert_after_heading',{notePath:`${SB}/hi.md`,heading:'extras',insertion:'inserted!'}));
tlog('replace_in_page',      await call('vaultnexus_replace_in_page',{notePath:`${SB}/hi.md`,find:'body',replace:'BODY'}));
tlog('rename_heading',       await call('vaultnexus_rename_heading',{notePath:`${SB}/hi.md`,oldText:'sub',newText:'subheading'}));
tlog('patch_section',        await call('vaultnexus_patch_section',{notePath:`${SB}/hi.md`,heading:'extras',newBody:'patched body line\n'}));
tlog('get_partial:heading',  await call('vaultnexus_get_partial',{notePath:`${SB}/hi.md`,kind:'heading',text:'extras'}));
tlog('search_replace_vault', await call('vaultnexus_search_replace_vault',{find:'BODY',replace:'B0DY',pathPrefix:SB}));
tlog('copy_page',            await call('vaultnexus_copy_page',{from:`${SB}/hi.md`,to:`${SB}/hi-copy.md`}));
tlog('move',                 await call('vaultnexus_move',{from:`${SB}/hi-copy.md`,to:`${SB}/hi-moved.md`}));
tlog('daily_note',           await call('vaultnexus_daily_note',{folder:SB}));
tlog('periodic_note:weekly', await call('vaultnexus_periodic_note',{period:'weekly',folder:SB}));
tlog('fetch_url',            await call('vaultnexus_fetch_url',{url:'https://example.com/',maxBytes:10000}));
tlog('delete_page',          await call('vaultnexus_delete_page',{notePath:`${SB}/hi.md`}));
tlog('delete_page#2',        await call('vaultnexus_delete_page',{notePath:`${SB}/hi-moved.md`}));
tlog('delete_folder',        await call('vaultnexus_delete_folder',{folderPath:SB,force:true}));

// Reasoning + history (last; less churn-sensitive)
tlog('history',              await call('vaultnexus_history',{notePath:'nonexistent.md',maxRevisions:3}));
tlog('recall_history',       await call('vaultnexus_recall_history',{notePath:'nonexistent.md'}));
tlog('forecasts',            await call('vaultnexus_forecasts',{}));
tlog('trace',                await call('vaultnexus_trace',{question:'hello',maxHops:1}));
tlog('reason',               await call('vaultnexus_reason',{question:'summarize'}));

console.log(`\n${fail===0?'✓ all 35 surfaces pass':`✗ ${fail} fail`} · ${pass} pass`);
child.stdin.end();
setTimeout(()=>process.exit(fail===0?0:1),300);
