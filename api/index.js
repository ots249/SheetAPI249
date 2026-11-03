import {google} from "googleapis";
import {Redis} from "@upstash/redis";
import crypto from "node:crypto";
const redis=new Redis({url:process.env.UPSTASH_REDIS_REST_URL,token:process.env.UPSTASH_REDIS_REST_TOKEN});
const COOKIE="s249_session";
const hash=x=>crypto.createHash("sha256").update(x).digest("hex");
const safeHashEqual=(a,b)=>{if(typeof a!=="string"||typeof b!=="string")return false;const x=Buffer.from(a,"hex"),y=Buffer.from(b,"hex");return x.length===y.length&&crypto.timingSafeEqual(x,y)};
const clientIp=req=>String(req.headers["x-forwarded-for"]||req.headers["x-real-ip"]||"unknown").split(",")[0].trim();
const random=()=>crypto.randomBytes(32).toString("hex");
const cacheStaleSeconds=()=>Math.max(30,Math.min(Number(process.env.CACHE_STALE_SECONDS)||300,3600));
async function bumpCacheVersion(slug){const p=redis.pipeline();p.incr("cachever:"+slug);p.set("cachever_at:"+slug,Date.now(),{ex:31536000});return p.exec()}

const oauth=()=>new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID,process.env.GOOGLE_CLIENT_SECRET,process.env.GOOGLE_REDIRECT_URI);
const send=(res,status,data)=>res.status(status).json(data);
function cookies(req){return Object.fromEntries((req.headers.cookie||"").split(";").map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf("=");return[x.slice(0,i),decodeURIComponent(x.slice(i+1))]}))}
async function session(req){const t=cookies(req)[COOKIE];return t?redis.get("session:"+hash(t)):null}
async function body(req){if(req.body&&typeof req.body==="object")return req.body;let s="",size=0;for await(const c of req){size+=Buffer.byteLength(c);if(size>1048576){const e=new Error("Request body exceeds 1 MB");e.statusCode=413;throw e}s+=c}try{return JSON.parse(s||"{}")}catch{return{}}}
const slug=s=>String(s||"").toLowerCase().trim().replace(/[^a-z0-9-]+/g,"-").replace(/^-|-$/g,"").slice(0,60);
export default async function handler(req,res){
 const origin=req.headers.origin;
 const allowedOrigins=(process.env.CORS_ORIGINS||"https://sheetapi249.vercel.app").split(",").map(x=>x.trim()).filter(Boolean);
 res.setHeader("Vary","Origin");res.setHeader("Access-Control-Allow-Headers","Content-Type,X-API-Key");res.setHeader("Access-Control-Allow-Methods","GET,POST,PUT,PATCH,DELETE,OPTIONS");
 if(origin&&allowedOrigins.includes(origin))res.setHeader("Access-Control-Allow-Origin",origin);
 if(req.method==="OPTIONS"){if(origin&&!allowedOrigins.includes(origin))return send(res,403,{success:false,error:"Origin not allowed"});return res.status(204).end()}
 const u=new URL(req.url,"https://local"),p=u.pathname;
 try{
  if(p==="/api/health"){let redisStatus="ok",latencyMs=null;const started=Date.now();try{await redis.ping();latencyMs=Date.now()-started}catch(e){redisStatus="error";console.error("Redis health check failed",e)}const healthy=redisStatus==="ok";return send(res,healthy?200:503,{success:healthy,service:"SheetAPI 249",status:healthy?"healthy":"degraded",checks:{redis:redisStatus},latencyMs,checkedAt:new Date().toISOString()})}
  if(p==="/api/auth/google"){const state=random();await redis.set("oauth:"+state,true,{ex:600});const url=oauth().generateAuthUrl({access_type:"offline",prompt:"consent",state,scope:["openid","email","profile","https://www.googleapis.com/auth/spreadsheets","https://www.googleapis.com/auth/drive.metadata.readonly"]});return res.redirect(url)}
  if(p==="/api/auth/google/callback"){const state=u.searchParams.get("state"),code=u.searchParams.get("code");if(!state||!code||!await redis.get("oauth:"+state))return send(res,400,{error:"Invalid OAuth state"});await redis.del("oauth:"+state);const got=await oauth().getToken(code),c=oauth();c.setCredentials(got.tokens);const info=(await google.oauth2({version:"v2",auth:c}).userinfo.get()).data;const profile={id:info.id,email:info.email,name:info.name};await redis.set("user:"+info.id,{tokens:got.tokens,profile},{ex:31536000});const sid=random();await redis.set("session:"+hash(sid),{userId:info.id,profile},{ex:604800});res.setHeader("Set-Cookie",COOKIE+"="+sid+"; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800");return res.redirect("/")}
  if(p==="/api/auth/me"){const s=await session(req);return send(res,200,{authenticated:!!s,profile:s?s.profile:null})}
  if(p==="/api/auth/logout"&&req.method==="POST"){const t=cookies(req)[COOKIE];if(t)await redis.del("session:"+hash(t));res.setHeader("Set-Cookie",COOKIE+"=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");return send(res,200,{success:true})}
  if(p==="/api/sheets"){const s=await session(req);if(!s)return send(res,401,{error:"Login required"});const user=await redis.get("user:"+s.userId),c=oauth();c.setCredentials(user.tokens);const d=google.drive({version:"v3",auth:c});const x=await d.files.list({q:"mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",fields:"files(id,name,webViewLink)",pageSize:100});return send(res,200,{success:true,spreadsheets:x.data.files||[]})}
  const tabs=p.match(/^\/api\/sheets\/([^/]+)\/tabs$/);if(tabs&&req.method==="GET"){const s=await session(req);if(!s)return send(res,401,{error:"Login required"});const spreadsheetId=decodeURIComponent(tabs[1]);const user=await redis.get("user:"+s.userId),c=oauth();c.setCredentials(user.tokens);const meta=await google.sheets({version:"v4",auth:c}).spreadsheets.get({spreadsheetId,fields:"spreadsheetId,properties(title),sheets(properties(sheetId,title,index))"});return send(res,200,{success:true,spreadsheetId,title:meta.data.properties?.title,tabs:(meta.data.sheets||[]).map(x=>x.properties)})}
  if(p==="/api/projects"&&req.method==="GET"){const s=await session(req);if(!s)return send(res,401,{error:"Login required"});return send(res,200,{success:true,projects:await redis.get("projects:"+s.userId)||[]})}
  if(p==="/api/projects"&&req.method==="POST"){const s=await session(req);if(!s)return send(res,401,{error:"Login required"});const b=await body(req),name=slug(b.name);if(!name||!b.spreadsheetId||!b.sheetName)return send(res,400,{error:"name, spreadsheetId and sheetName required"});if(await redis.get("project:"+name))return send(res,409,{error:"Project name already exists"});const key="s249_"+random(),project={id:random(),userId:s.userId,name:b.name,slug:name,spreadsheetId:b.spreadsheetId,sheetName:String(b.sheetName),access:b.access==="private"?"private":"public",allowWrite:b.allowWrite===true,cacheSeconds:Math.max(0,Math.min(Number(b.cacheSeconds??60),86400)),apiKeyHash:hash(key),permissions:{read:true,write:b.allowWrite===true},allowedIps:Array.isArray(b.allowedIps)?b.allowedIps.filter(x=>typeof x==="string").slice(0,50):[]};const all=await redis.get("projects:"+s.userId)||[];all.push(project);await redis.set("projects:"+s.userId,all,{ex:31536000});await redis.set("project:"+name,project,{ex:31536000});return send(res,201,{success:true,project:{...project,apiKey:key}})}
  const projectManage=p.match(/^\\/api\\/projects\\/([^/]+)$/);
  if(projectManage&&["PATCH","DELETE"].includes(req.method)){
   const s=await session(req);if(!s)return send(res,401,{error:"Login required"});
   const list=await redis.get("projects:"+s.userId)||[],pr=list.find(x=>x.id===projectManage[1]);
   if(!pr)return send(res,404,{error:"Project not found"});
   if(req.method==="PATCH"){
    const b=await body(req),next={...pr};
    if(b.name!==undefined){const n=String(b.name).trim(),newSlug=slug(n);if(!n||!newSlug)return send(res,400,{error:"Valid project name is required"});const conflict=list.some(x=>x.id!==pr.id&&x.slug===newSlug);if(conflict||await redis.get("project:"+newSlug)&&newSlug!==pr.slug)return send(res,409,{error:"Project name already exists"});next.name=n;next.slug=newSlug}
    if(b.spreadsheetId!==undefined){const id=String(b.spreadsheetId).trim();if(!/^[a-zA-Z0-9_-]{20,}$/.test(id))return send(res,400,{error:"Invalid Google Sheets ID"});next.spreadsheetId=id}
    if(b.sheetName!==undefined){const tab=String(b.sheetName).trim();if(!tab||tab.length>200)return send(res,400,{error:"Valid sheet name is required"});next.sheetName=tab}
    const updated=list.map(x=>x.id===pr.id?next:x);
    await redis.set("projects:"+s.userId,updated,{ex:31536000});
    if(next.slug!==pr.slug)await redis.del("project:"+pr.slug);
    await redis.set("project:"+next.slug,next,{ex:31536000});
    await bumpCacheVersion(pr.slug);if(next.slug!==pr.slug)await bumpCacheVersion(next.slug);
    return send(res,200,{success:true,project:{id:next.id,name:next.name,slug:next.slug,spreadsheetId:next.spreadsheetId,sheetName:next.sheetName}});
   }
   const remaining=list.filter(x=>x.id!==pr.id);
   const pipe=redis.pipeline();pipe.set("projects:"+s.userId,remaining,{ex:31536000});pipe.del("project:"+pr.slug,"stats:"+pr.id,"errors:"+pr.id,"audit:"+pr.id,"cachever:"+pr.slug,"cachever_at:"+pr.slug);
   for(let i=0;i<90;i++){const d=new Date();d.setUTCDate(d.getUTCDate()-i);pipe.del("stats:daily:"+pr.id+":"+d.toISOString().slice(0,10))}
   await pipe.exec();
   return send(res,200,{success:true,deleted:true});
  }
  const ownedProject=async(id,userId)=>{const list=await redis.get("projects:"+userId)||[];return list.find(x=>x.id===id)||null};
  const manage=p.match(/^\/api\/projects\/([^/]+)\/(key|settings|analytics|audit|errors)$/);
  if(manage&&req.method==="GET"&&manage[2]==="audit"){const s=await session(req);if(!s)return send(res,401,{error:"Login required"});const pr=await ownedProject(manage[1],s.userId);if(!pr)return send(res,404,{error:"Project not found"});const limit=Math.min(200,Math.max(1,Number(u.searchParams.get("limit")||50)));const logs=await redis.lrange("audit:"+pr.id,0,limit-1);return send(res,200,{success:true,logs:(logs||[]).map(x=>typeof x==="string"?JSON.parse(x):x)})}
  if(manage&&req.method==="GET"&&manage[2]==="analytics"){const s=await session(req);if(!s)return send(res,401,{error:"Login required"});const pr=await ownedProject(manage[1],s.userId);if(!pr)return send(res,404,{error:"Project not found"});const days=Math.min(30,Math.max(7,Number(u.searchParams.get("days")||7)));const trend=[];for(let i=days-1;i>=0;i--){const d=new Date();d.setUTCDate(d.getUTCDate()-i);const day=d.toISOString().slice(0,10);trend.push({date:day,...(await redis.get("stats:daily:"+pr.id+":"+day)||{requests:0,success:0,errors:0})})}return send(res,200,{success:true,stats:await redis.get("stats:"+pr.id)||{requests:0,success:0,errors:0},trend})}
  if(manage&&req.method==="GET"&&manage[2]==="errors"){const s=await session(req);if(!s)return send(res,401,{error:"Login required"});const pr=await ownedProject(manage[1],s.userId);if(!pr)return send(res,404,{error:"Project not found"});const limit=Math.min(100,Math.max(1,Number(u.searchParams.get("limit")||30)));const events=await redis.lrange("errors:"+pr.id,0,limit-1);return send(res,200,{success:true,errors:(events||[]).map(x=>typeof x==="string"?JSON.parse(x):x)})}
  if(manage&&manage[2]==="key"&&req.method==="POST"){const s=await session(req);if(!s)return send(res,401,{error:"Login required"});const pr=await ownedProject(manage[1],s.userId);if(!pr)return send(res,404,{error:"Project not found"});const key="s249_"+random();pr.apiKeyHash=hash(key);const list=await redis.get("projects:"+s.userId)||[];await redis.set("projects:"+s.userId,list.map(x=>x.id===pr.id?pr:x),{ex:31536000});await redis.set("project:"+pr.slug,pr,{ex:31536000});return send(res,200,{success:true,apiKey:key})}
  if(manage&&manage[2]==="settings"&&req.method==="PATCH"){const s=await session(req);if(!s)return send(res,401,{error:"Login required"});const pr=await ownedProject(manage[1],s.userId);if(!pr)return send(res,404,{error:"Project not found"});const b=await body(req);if(b.access!==undefined){if(!["public","private"].includes(b.access))return send(res,400,{error:"Invalid access mode"});pr.access=b.access}if(b.allowWrite!==undefined){pr.allowWrite=!!b.allowWrite;pr.permissions={...(pr.permissions||{read:true}),write:!!b.allowWrite}}if(b.permissions!==undefined){if(!b.permissions||typeof b.permissions!=="object"||Array.isArray(b.permissions))return send(res,400,{error:"permissions must be an object"});pr.permissions={read:b.permissions.read!==false,write:b.permissions.write===true};pr.allowWrite=pr.permissions.write}if(b.allowedIps!==undefined){if(!Array.isArray(b.allowedIps)||b.allowedIps.length>50||b.allowedIps.some(x=>typeof x!=="string"||x.length>64))return send(res,400,{error:"allowedIps must be an array of up to 50 IP addresses"});pr.allowedIps=[...new Set(b.allowedIps)]}if(b.cacheSeconds!==undefined)pr.cacheSeconds=Math.max(0,Math.min(Number(b.cacheSeconds)||0,86400));const list=await redis.get("projects:"+s.userId)||[];await redis.set("projects:"+s.userId,list.map(x=>x.id===pr.id?pr:x),{ex:31536000});await redis.set("project:"+pr.slug,pr,{ex:31536000});await bumpCacheVersion(pr.slug);return send(res,200,{success:true,project:{id:pr.id,access:pr.access,cacheSeconds:pr.cacheSeconds}})}
  const refresh=p.match(/^\/api\/projects\/([^/]+)\/refresh$/);if(refresh&&req.method==="POST"){const s=await session(req);if(!s)return send(res,401,{error:"Login required"});const all=await redis.get("projects:"+s.userId)||[],pr=all.find(x=>x.id===refresh[1]);if(!pr)return send(res,404,{error:"Project not found"});await bumpCacheVersion(pr.slug);return send(res,200,{success:true})}
  const data=p.match(/^\/api\/v1\/([^/]+)\/([^/]+)$/);
  if(data&&["GET","POST","PUT","PATCH","DELETE"].includes(req.method)){
   const pr=await redis.get("project:"+data[1]);
   if(!pr)return send(res,404,{success:false,error:"Project not found"});
   const bump=async(field)=>{const k="stats:"+pr.id,day=new Date().toISOString().slice(0,10),dk="stats:daily:"+pr.id+":"+day;const script="for i=1,2 do local v=redis.call('GET',KEYS[i]); local s={requests=0,success=0,errors=0}; if v then s=cjson.decode(v) end; s[ARGV[1]]=(tonumber(s[ARGV[1]]) or 0)+1; redis.call('SET',KEYS[i],cjson.encode(s),'EX',ARGV[2]); end; return 1";await redis.eval(script,[k,dk],[field,field==="requests"?31536000:7776000]);};
   const ip=clientIp(req);
   const allowedIps=Array.isArray(pr.allowedIps)?pr.allowedIps:[];
   if(allowedIps.length&&!allowedIps.includes(ip))return send(res,403,{success:false,error:"IP address is not allowed for this project"});
   const rateKey="ratelimit:"+pr.id+":"+hash(ip);
   const rateLimit=req.method==="GET"?120:30;
   const rateCount=Number(await redis.eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n",[rateKey],[]));
   res.setHeader("X-RateLimit-Limit",String(rateLimit));res.setHeader("X-RateLimit-Remaining",String(Math.max(0,rateLimit-rateCount)));
   if(rateCount>rateLimit){res.setHeader("Retry-After","60");return send(res,429,{success:false,error:"Rate limit exceeded. Try again in 60 seconds."})}
   await bump("requests");
   const tracked=async(status,payload)=>{await bump(status>=200&&status<400?"success":"errors");try{const log={at:new Date().toISOString(),method:req.method,status,ipHash:hash(ip).slice(0,16),sheet:pr.sheetName};if(status>=400){const ep=redis.pipeline(),ek="errors:"+pr.id;ep.lpush(ek,JSON.stringify({at:log.at,method:req.method,status,error:payload?.error||"Request failed"}));ep.ltrim(ek,0,99);ep.expire(ek,7776000);await ep.exec()}const auditKey="audit:"+pr.id,pipe=redis.pipeline();pipe.lpush(auditKey,JSON.stringify(log));pipe.ltrim(auditKey,0,499);pipe.expire(auditKey,7776000);await pipe.exec()}catch(auditError){console.error("Audit log write failed",auditError)}return send(res,status,payload)};
   try{
    if(decodeURIComponent(data[2])!==pr.sheetName)return await tracked(403,{success:false,error:"Sheet not configured"});
    const key=req.headers["x-api-key"];
    if(pr.access==="private"&&(!key||!safeHashEqual(hash(key),pr.apiKeyHash)))return await tracked(401,{success:false,error:"Invalid API key"});
    const permissions=pr.permissions||{read:true,write:pr.allowWrite===true};
    if(req.method==="GET"&&permissions.read===false)return await tracked(403,{success:false,error:"Read permission is disabled for this project"});
    if(req.method!=="GET"&&(!key||!safeHashEqual(hash(key),pr.apiKeyHash)))return await tracked(401,{success:false,error:"A valid X-API-Key is required for write operations"});
    if(req.method!=="GET"&&(!pr.allowWrite||permissions.write!==true))return await tracked(403,{success:false,error:"Write permission is disabled for this project"});
    if(req.method!=="GET"){
     const b=await body(req),user=await redis.get("user:"+pr.userId),c=oauth();c.setCredentials(user.tokens);
     const sheets=google.sheets({version:"v4",auth:c}),quoted="'"+pr.sheetName.replace(/'/g,"''")+"'";
     if(req.method==="POST"){
      const rows=Array.isArray(b.data)?b.data:[b.data??b];
      if(!rows.length||rows.some(x=>!x||typeof x!=="object"||Array.isArray(x)))return await tracked(400,{success:false,error:"Send data as an object or array of objects"});
      if(rows.length>500)return await tracked(413,{success:false,error:"Batch limit is 500 rows per request"});
      const meta=await sheets.spreadsheets.values.get({spreadsheetId:pr.spreadsheetId,range:quoted+"!1:1"}),headers=meta.data.values?.[0]||[];
      if(!headers.length)return await tracked(400,{success:false,error:"First row must contain column headers"});
      const values=rows.map(x=>headers.map(h=>x[h]??""));
      const result=await sheets.spreadsheets.values.append({spreadsheetId:pr.spreadsheetId,range:quoted+"!A:ZZ",valueInputOption:"USER_ENTERED",insertDataOption:"INSERT_ROWS",requestBody:{values}});
      await bumpCacheVersion(pr.slug);
      return await tracked(201,{success:true,insertedRows:values.length,updatedRange:result.data.updates?.updatedRange});
     }
     const row=Number(u.searchParams.get("row")??b.row);
     if(!Number.isInteger(row)||row<2)return await tracked(400,{success:false,error:"Specify row number >= 2 using ?row= or body.row"});
     const range=quoted+"!A"+row+":ZZ"+row;
     const current=await sheets.spreadsheets.values.get({spreadsheetId:pr.spreadsheetId,range,valueRenderOption:"UNFORMATTED_VALUE"});
     if(!current.data.values?.length)return await tracked(404,{success:false,error:"Row not found"});
     if(req.method==="DELETE"){
      const meta=await sheets.spreadsheets.get({spreadsheetId:pr.spreadsheetId,fields:"sheets(properties(sheetId,title))"}),sh=meta.data.sheets?.find(x=>x.properties.title===pr.sheetName);
      if(!sh)return await tracked(404,{success:false,error:"Sheet not found"});
      await sheets.spreadsheets.batchUpdate({spreadsheetId:pr.spreadsheetId,requestBody:{requests:[{deleteDimension:{range:{sheetId:sh.properties.sheetId,dimension:"ROWS",startIndex:row-1,endIndex:row}}}]}});
      await bumpCacheVersion(pr.slug);
      return await tracked(200,{success:true,deletedRow:row});
     }
     const meta=await sheets.spreadsheets.values.get({spreadsheetId:pr.spreadsheetId,range:quoted+"!1:1"}),headers=meta.data.values?.[0]||[];
     const old=Object.fromEntries(headers.map((h,i)=>[h,current.data.values[0][i]??""]));
     const next=req.method==="PUT"?Object.fromEntries(headers.map(h=>[h,b.data?.[h]??""])):{...old,...(b.data||b)};
     const values=[headers.map(h=>next[h]??"")];
     await sheets.spreadsheets.values.update({spreadsheetId:pr.spreadsheetId,range,valueInputOption:"USER_ENTERED",requestBody:{values}});
     await bumpCacheVersion(pr.slug);
     return await tracked(200,{success:true,updatedRow:row,data:next});
    }
    const searchParam=u.searchParams.get("search")||"";
    const requestedLimit=u.searchParams.get("limit");
    const requestedOffset=u.searchParams.get("offset")||"0";
    if(searchParam.length>200)return await tracked(400,{success:false,error:"search must be 200 characters or fewer"});
    if(requestedLimit!==null&&(!Number.isInteger(Number(requestedLimit))||Number(requestedLimit)<1||Number(requestedLimit)>1000))return await tracked(400,{success:false,error:"limit must be an integer between 1 and 1000"});
    if(!/^\d+$/.test(requestedOffset)||Number(requestedOffset)>10000000)return await tracked(400,{success:false,error:"offset must be a non-negative integer no greater than 10000000"});
    const cacheVersion=await redis.get("cachever:"+pr.slug)||0;
    const cacheIdentity=JSON.stringify({sheet:pr.sheetName,search:searchParam.toLowerCase(),limit:requestedLimit,offset:requestedOffset,version:cacheVersion});
    const cacheKey="data:"+pr.slug+":"+hash(cacheIdentity);
    const refreshData=async()=>{
     const user=await redis.get("user:"+pr.userId),c=oauth();c.setCredentials(user.tokens);
     const range="'"+pr.sheetName.replace(/'/g,"''")+"'!A:ZZ";
     const result=await google.sheets({version:"v4",auth:c}).spreadsheets.values.get({spreadsheetId:pr.spreadsheetId,range,valueRenderOption:"UNFORMATTED_VALUE"});
     const values=result.data.values||[],headers=(values[0]||[]).map((v,i)=>String(v||"column_"+(i+1)));
     let rows=values.slice(1).filter(r=>r.some(v=>v!==""&&v!==null)).map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]??null])));
     if(searchParam)rows=rows.filter(r=>JSON.stringify(r).toLowerCase().includes(searchParam.toLowerCase()));
     const total=rows.length,limit=requestedLimit===null?total:Number(requestedLimit),offset=Number(requestedOffset);
     const payload={success:true,project:pr.slug,sheet:pr.sheetName,total,limit,offset,data:rows.slice(offset,offset+limit)};
     if(pr.cacheSeconds>0)await redis.set(cacheKey,{payload,cachedAt:Date.now()},{ex:pr.cacheSeconds+cacheStaleSeconds()});
     return payload;
    };
    if(pr.cacheSeconds>0){
     const cached=await redis.get(cacheKey);
     if(cached?.payload){
      const age=Math.max(0,Date.now()-Number(cached.cachedAt||0)),freshFor=pr.cacheSeconds*1000;
      if(age<=freshFor)return await tracked(200,{...cached.payload,cached:true,cacheState:"fresh"});
      const lockKey="cache-refresh:"+hash(cacheKey),lock=await redis.set(lockKey,"1",{nx:true,ex:30});
      if(lock==="OK"){
       refreshData().catch(err=>{console.error("Stale cache refresh failed",err)}).finally(()=>redis.del(lockKey).catch(err=>console.error("Cache refresh lock cleanup failed",err)));
       return await tracked(200,{...cached.payload,cached:true,stale:true,cacheState:"stale"});
      }
      return await tracked(200,{...cached.payload,cached:true,stale:true,cacheState:"refreshing"});
     }
    }
    const out=await refreshData();
    return await tracked(200,{...out,cached:false,cacheState:"miss"});
   }catch(routeError){await bump("errors");throw routeError}
  }
  if(p.startsWith("/api/projects/")&&req.method==="DELETE"){const s=await session(req);if(!s)return send(res,401,{error:"Login required"});const id=p.split("/").pop(),all=await redis.get("projects:"+s.userId)||[],pr=all.find(x=>x.id===id);if(!pr)return send(res,404,{error:"Not found"});await redis.set("projects:"+s.userId,all.filter(x=>x.id!==id),{ex:31536000});await redis.del("project:"+pr.slug,"cachever:"+pr.slug);return send(res,200,{success:true})}
  return send(res,404,{success:false,error:"Route not found"});
 }catch(e){console.error(e);return send(res,e.statusCode||500,{success:false,error:e.message||"Internal error"})}
}