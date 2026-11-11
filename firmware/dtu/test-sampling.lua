-- Run from firmware/dtu with Lua 5.3.
local f=assert(io.open("sampling-task.lua"))
local src=f:read("*a"); f:close()
-- online: true = ONLINE_IMEI set on DTU firmware with PronetSetNetwt; "old" = set, but firmware lacks it.
local function simulate(deep,wd,faults,online)
    local env=setmetatable({},{__index=_G})
    local ms,serial,network,events,up,db=0,{},{},{},1,{}
    env.mcu={ticks=function() return math.floor(ms/10) end,hz=function() return 100 end}
    local utc=1700000000
    env.os={time=function() return utc+math.floor(ms/1000) end,date=os.date}
    env.mobile={imei=function()
        if faults and ms<5000 then error("identity not ready") end
        return "123456789012345"
    end}
    env.sys={wait=function() coroutine.yield() end}
    env.UartStopProRecCh=function(v) assert(v==1) end
    env.PronetStopProRecCh=env.UartStopProRecCh
    env.PronetGetNetSta=function() return up end
    env.UartGetRecChAndDel=function() return table.remove(serial,1) end
    env.PronetGetRecChAndDel=function() return table.remove(network,1) end
    env.UartSetSendCh=function(_,s) events[#events+1]=s end
    local failSend,failEncode=false,false
    env.PronetSetSendCh=function(_,_)
        if failSend then error("temporary send failure") end
        events[#events+1]="report"
    end
    env.json={encode=function(d)
        if failEncode then error("temporary encoder failure") end
        assert(d.lpp==1 and d.imei=="123456789012345"); return "{}"
    end}
    env.GpsSetPower=function(n) events[#events+1]="gps"..n end
    if online then
        env.pm={WORK_MODE=1,power=function(_,v) events[#events+1]="pm"..v end}
        if online~="old" then env.PronetSetNetwt=function(ms) events[#events+1]="netwt"..ms end end
    end
    env.fskv={set=function(k,v) db[k]=v end,get=function(k) return db[k] end}
    env.PerIsHwdg=function() return wd end
    env.SysNeedInSuperPower=function() events[#events+1]="exit network" end
    env.SysInSuperLowPower=function(n) events[#events+1]="sleep "..n end
    local fixed,partial=false,false
    -- skew: module clock ahead of GNSS time; frozen: GNSS keeps returning one cached RMC.
    local skew,frozen=0,nil
    env.libgnss={isFix=function() return fixed end,getRmc=function()
        local t=os.date("!*t",frozen or (env.os.time()-skew))
        if partial then t.month=nil end
        t.lng=114; t.lat=30
        return t
    end}
    local text=src:gsub("^function","return function()",1)
    if deep then text=text:gsub('local DEEP_IMEI = ""','local DEEP_IMEI = "123456789012345"') end
    if online then text=text:gsub('local ONLINE_IMEI = ""','local ONLINE_IMEI = "123456789012345"') end
    local co=coroutine.create(assert(load(text,"DTU","t",env))())
    local function step(s,n)
        if s then serial[#serial+1]=s end
        for i=1,n or 1 do ms=ms+1000; local ok,err=coroutine.resume(co); assert(ok,err) end
    end
    step()
    local function has(s) for _,v in ipairs(events) do if v==s then return true end end end
    local function since(n,s) for i=n+1,#events do if events[i]==s then return true end end end
    -- Online low power: both calls together, and only on DTU firmware that has PronetSetNetwt.
    assert((has("netwt1000") and has("pm2") or false)==(online==true))
    assert(not has("pm2") or has("netwt1000"))
    if faults then
        step("why=pad,seq=0\r\n")
        assert(not has("report") and not has("net=1\r\n"))
        step(nil,5); assert(has("net=1\r\n"))
        failSend=true; step("why=pad,seq=0\r\n"); failSend=false
        failEncode=true; step("why=pad,seq=0\r\n"); failEncode=false
        assert(not has("report"))
        network[#network+1]="wipe m=f s="; step()
        up=0; step(); up=1; network[#network+1]="88\nnet=1\nok\n"; step()
        assert(not has("wipe m=f s=88\r\n") and has("ok\r\n"))
        fixed,partial=true,true
    end
    assert(has((deep and not wd and "lpready=2" or "lpready=1").."\r\n"))
    step("lp fix 100 3\r\n"); assert(has("gps1"))
    step("why=pad,seq=1\r\n"); assert(has("report"))
    network[#network+1]="ok p=300 c=0 t=0 j=1 v="
    step(); network[#network+1]="7\n"; step(); assert(has("ok p=300 c=0 t=0 j=1 v=7\r\n"))
    assert(events[#events]=="gps0" or has("gps0"))
    fixed,partial=true,false
    step("lp fix 101 60\r\n"); step()
    local point="fix=101 114000000/30000000/"..(utc+math.floor(ms/1000)).."\r\n"
    assert(has(point))
    -- Module clock 5 s ahead: the first fix after the request is still taken, stamped with GNSS time.
    skew=5
    step("lp fix 102 60\r\n"); step()
    assert(has("fix=102 114000000/30000000/"..(utc+math.floor(ms/1000)-skew).."\r\n"))
    -- Only the RMC cached before the request: no fix is reported, GNSS goes off at the budget.
    frozen=env.os.time()-skew
    step("lp fix 103 3\r\n",5)
    for _,v in ipairs(events) do assert(not v:find("fix=103",1,true)) end
    assert(events[#events]=="gps0" or has("gps0"))
    -- Indoors: after three searches in a row end without a fix, only 1 of every 3 requests powers GNSS.
    skew=0; frozen=env.os.time()
    step("lp fix 104 2\r\n",4); step("lp fix 105 2\r\n",4)
    local n=#events; step("lp fix 106 2\r\n",3); assert(not since(n,"gps1"))
    n=#events; step("lp fix 107 2\r\n",3); assert(not since(n,"gps1"))
    n=#events; step("lp fix 108 60\r\n"); assert(since(n,"gps1"))
    -- A fix ends the backoff: the next request searches again.
    frozen=nil; step()
    assert(has("fix=108 114000000/30000000/"..(utc+math.floor(ms/1000)).."\r\n"))
    n=#events; step("lp fix 109 60\r\n"); assert(since(n,"gps1"))
    step(); assert(has("fix=109 114000000/30000000/"..(utc+math.floor(ms/1000)).."\r\n"))
    frozen,skew=nil,0
    step("lp save 7 600 8 0\r\n"); assert(has("saved=7 600 8 0\r\n"))
    step("lp sleep 540 7\r\n",6); assert(not has("exit network"))
    step("lp sleep 540 7\r\n"); step("lp commit\r\nlp cancel\r\n",4); assert(not has("exit network"))
    step("lp sleep 540 7\r\n"); step("lp commit\r\n",4)
    assert((has("sleep 538") or false)==(deep and not wd))
end
simulate(false,nil); simulate(true,nil); simulate(true,1); simulate(false,nil,true)
simulate(false,nil,false,true); simulate(false,nil,false,"old")
print("PASS vendor task: fragmented downlink, GNSS timeout, fix after request despite clock skew, cached fix ignored, indoor GNSS backoff, online low power gate, event during search, sleep gates and cancellation")
