function
    -- Install as the sole task on a single-channel TCP/TTL DTU. Data templates are empty.
    local uid, nid = 1, 1
    assert(mcu and type(mcu.ticks)=="function" and type(PronetSetSendCh)=="function"
        and type(UartSetSendCh)=="function" and type(PronetGetNetSta)=="function"
        and type(PronetStopProRecCh)=="function" and type(UartStopProRecCh)=="function"
        and type(UartGetRecChAndDel)=="function" and type(PronetGetRecChAndDel)=="function",
        "DTU firmware does not support the sampling task")
    -- Enter only the IMEI of a bench-qualified unit, independently for each experiment.
    -- ONLINE_IMEI: online low power. Needs DTU firmware V2.0.9+ (PronetSetNetwt); ignored on older firmware.
    local ONLINE_IMEI = ""
    local DEEP_IMEI = ""
    local imei, idAttempt
    local function selected(id) return id ~= "" and id == imei end
    local function call(fn, ...)
        if type(fn) ~= "function" then return nil end
        local ok, value = pcall(fn, ...)
        if ok then return value end
    end
    local key = "sample_lp_state_v1"
    local saved = fskv and call(fskv.get, key)
    local canDeep = false
    local function identify()
        local id = tostring(call(mobile.imei) or "")
        if #id<14 or #id>17 or not id:match("^%d+$") then return end
        imei=id
        if selected(DEEP_IMEI) and type(SysNeedInSuperPower)=="function"
            and type(SysInSuperLowPower)=="function" and type(PerIsHwdg)=="function" and fskv then
            local ok, present=pcall(PerIsHwdg)
            canDeep=ok and present==nil
        end
        -- pm.power cannot enter low power while the network poll stays at its 50 ms default,
        -- so both are set together, and only where PronetSetNetwt exists.
        if selected(ONLINE_IMEI) and type(PronetSetNetwt)=="function" and pm and pm.power then
            call(PronetSetNetwt,1000)
            call(pm.power,pm.WORK_MODE,2)
        end
    end

    local function uartLine(line) call(UartSetSendCh,uid,line.."\r\n") end
    local function ready() uartLine(canDeep and "lpready=2" or "lpready=1") end
    local hz = assert(call(mcu.hz), "DTU clock frequency unavailable")
    assert(hz > 0)
    local function ticks() return mcu.ticks() end
    local function elapsed(now,start) return ((now-start) % 4294967296) * (1000.0/hz) end
    local net, seen, synced = -1, nil, false
    local token, started, budget, finished, beforeRmc, latest, pendingSleep
    -- Indoors: after 3 searches in a row end without a fix, search on 1 of every 3 requests.
    local misses, skipped = 0, 0
    local want, applied, tried = 0, nil, nil
    local function power(now)
        if applied==want or (tried and elapsed(now,tried)<2000) then return end
        tried=now
        local ok, result=pcall(GpsSetPower,want)
        if ok and result~=false then applied=want else applied=nil end
    end
    local function setPower(on, now)
        if want~=on then want=on; tried=nil end
        power(now)
    end
    local function rmc()
        if not libgnss or not call(libgnss.isFix) then return end
        return call(libgnss.getRmc,2)
    end
    local function stamp(r)
        if type(r)~="table" then return end
        -- A partial RMC during acquisition must not stop the serial/network loop.
        return call(string.format,"%04d-%02d-%02d %02d:%02d:%02d",r.year,r.month,r.day,r.hour,r.min,r.sec)
    end
    -- RMC UTC fields to Unix seconds. Pure arithmetic: no timezone, no network clock.
    local function utcEpoch(r)
        local y,m,d=tonumber(r.year),tonumber(r.month),tonumber(r.day)
        local hh,mm,ss=tonumber(r.hour),tonumber(r.min),tonumber(r.sec)
        if not (y and m and d and hh and mm and ss) then return end
        y,m,d,hh,mm,ss=math.floor(y),math.floor(m),math.floor(d),math.floor(hh),math.floor(mm),math.floor(ss)
        if y<100 then y=y+2000 end
        if m<1 or m>12 or d<1 or d>31 or hh<0 or hh>23 or mm<0 or mm>59 or ss<0 or ss>60 then return end
        if m<=2 then y=y-1 end
        local era=y//400
        local yoe=y-era*400
        local doy=(153*((m+9)%12)+2)//5+d-1
        local doe=yoe*365+yoe//4-yoe//100+doy
        return math.floor((era*146097+doe-719468)*86400+hh*3600+mm*60+ss)
    end
    local function tickGps(now)
        power(now)
        if not token or finished then return end
        if elapsed(now,started)>=budget then finished=true; misses=misses+1; setPower(0,now); return end
        if applied~=1 then return end
        local r=rmc()
        local utc=stamp(r)
        -- Accept the first fix newer than the one held when the STM asked: it was computed
        -- after the request. A cached fix from before GNSS power-off equals beforeRmc and is
        -- skipped. The fix carries its own UTC time, so the module clock may be off or unsynced.
        if not utc or (beforeRmc and utc<=beforeRmc) then return end
        local epoch=utcEpoch(r)
        if not epoch or epoch<=1600000000 then return end
        local lng,lat=tonumber(r.lng),tonumber(r.lat)
        if not lng or not lat or not (math.abs(lng)<=180 and math.abs(lat)<=90) or (lng==0 and lat==0) then return end
        local coords=string.format("%.0f/%.0f/%d",lng*1000000,lat*1000000,epoch)
        local ga=call(libgnss.getGga,2)
        latest={token=token,xy=coords,r=r,utc=utc,ga=type(ga)=="table" and ga or {}}
        uartLine("fix="..token.." "..coords)
        finished=true; misses=0; skipped=0
        setPower(0,now)
    end

    local function report(line)
        if net~=1 then return end -- STM retains q until the server acknowledges it.
        local d={uart=line.."\r\n",imei=imei,iccid=call(mobile.iccid),imsi=call(mobile.imsi),
            time=os.date("%Y-%m-%d %H:%M:%S"),timem=tostring(os.time()).."000",csq=call(mobile.csq),lpp=1,gpsfix=0}
        d.vbat=tonumber(line:match(",bat=(%d+)")) or call(PerGetVbattV)
        local xy=line:match(",xy=([%d/%-]+)")
        if latest and xy==latest.xy then
            d.gpsfix=1; d.lng=latest.r.lng; d.lat=latest.r.lat
            d.speed=latest.r.speed; d.course=latest.r.course; d.gpstime=latest.utc
            d.alt=latest.ga.altitude; d.sats=latest.ga.satellites_tracked; d.hdop=latest.ga.hdop
        end
        if not line:find(",bf=1",1,true) and type(GetLbs)=="function" then
            local ok,lng,lat=pcall(GetLbs)
            if ok then d.lbslng=lng; d.lbslat=lat end
        end
        local payload=call(json.encode,d)
        if type(payload)=="string" then call(PronetSetSendCh,nid,payload) end
    end

    local function fromStm(line,now)
        if line:match("^why=") then
            if pendingSleep then pendingSleep=nil; ready(); uartLine("net="..math.max(0,net)) end
            report(line); return
        end
        local id,secs=line:match("^lp fix (%d+) (%d+)$")
        if id then
            pendingSleep=nil
            if token~=id then
                token,started,budget,finished=id,now,math.min(60,tonumber(secs))*1000,false
                -- A skipped request sends no fix; the STM reports on time without coordinates.
                if misses>=3 and skipped<2 then
                    skipped=skipped+1; finished=true; setPower(0,now); return
                end
                skipped=0
                beforeRmc=stamp(rmc())
                setPower(1,now)
            elseif latest and latest.token==id then uartLine("fix="..id.." "..latest.xy) end
            return
        end
        if line=="lp commit" then
            if pendingSleep then pendingSleep.committed=true end
            return
        end
        if line=="lp gps-off" then token=nil; latest=nil; setPower(0,now); return end
        if line=="lp cancel" then pendingSleep=nil; ready(); uartLine("net="..math.max(0,net)); return end
        if line=="lp clear" then
            pendingSleep=nil; token=nil; latest=nil; saved=nil; misses=0; skipped=0; setPower(0,now)
            if fskv then call(fskv.del,key) end
            return
        end
        local state=line:match("^lp save (%d+ %d+ %d+ %d+)$")
        if state and fskv then
            if saved~=state then call(fskv.set,key,state); saved=call(fskv.get,key) end
            if saved==state then uartLine("saved="..state) end
            return
        end
        local delay,version=line:match("^lp sleep (%d+) (%d+)$")
        if delay then
            if canDeep and saved and saved:match("^(%d+) ")==version and tonumber(delay)>=10
                and tonumber(delay)<=3600 and applied==0 then
                pendingSleep={at=now,seconds=tonumber(delay)}
                uartLine("sleeping=1")
            else ready(); uartLine("net="..math.max(0,net)) end
        end
    end
    local function fromServer(line)
        if line~="ok" and not line:match("^ok ") and not line:match("^wipe ") and not line:match("^dump ") then return end
        if pendingSleep then pendingSleep=nil; ready(); uartLine("net="..math.max(0,net)) end
        local led=line:match("^ok .* m=([01])")
        if led then
            local v=tonumber(led)
            if call(PerGetLedSta)~=v then call(PerSetLedSta,v) end
        end
        uartLine(line)
    end
    -- DTU buffers can return partial or coalesced lines. Discard an entire oversize frame.
    local function reader(get,id,limit)
        local tail,overflow="",false
        return function(handle,now)
            for i=1,16 do
                local s=call(get,id)
                if type(s)~="string" or s=="" then break end
                local pos=1
                while pos<=#s do
                    local e=s:find("\n",pos,true)
                    local part=s:sub(pos,e and e-1 or #s)
                    if not overflow and #tail+#part<=limit then tail=tail..part else tail=""; overflow=true end
                    if not e then break end
                    if not overflow and tail~="" then handle((tail:gsub("\r$","")),now) end
                    pos=e+1; tail=""; overflow=false
                end
            end
        end, function() tail=""; overflow=false end
    end
    PronetStopProRecCh(1)
    UartStopProRecCh(1)
    local rx=reader(UartGetRecChAndDel,uid,1024)
    local down,resetDown=reader(PronetGetRecChAndDel,nid,512)
    local function discard() end
    -- The vendor super-sleep helper can leave flight mode enabled across its wake/reset.
    if pm and pm.lastReson then
        local ok,_,sleep=pcall(pm.lastReson)
        if ok and type(sleep)=="number" and sleep>0 then call(mobile.flymode,0,false) end
    end
    uartLine("lpreboot=1"); ready(); uartLine("net=0")
    while true do
        local now=ticks()
        if not imei and (not idAttempt or elapsed(now,idAttempt)>=5000) then
            idAttempt=now; identify()
        end
        local up=imei and call(PronetGetNetSta,nid)==1 and 1 or 0
        if up~=net then resetDown() end
        if up~=net and pendingSleep then pendingSleep=nil; ready() end
        if up~=net or not seen or elapsed(now,seen)>=60000 then
            net=up; seen=now; ready(); uartLine("net="..up)
            if up==1 and not synced then call(ProSetNeedNtp) end
            if os.time()>1700000000 then
                synced=true; uartLine("ntp="..os.time().."000")
                if type(saved)=="string" then uartLine("restore="..saved) end
            end
        end
        down(up==1 and fromServer or discard,now)
        rx(fromStm,now)
        tickGps(now)
        if pendingSleep and not pendingSleep.committed and elapsed(now,pendingSleep.at)>=4000 then
            pendingSleep=nil; ready(); uartLine("net="..math.max(0,net))
        end
        if pendingSleep and pendingSleep.committed and elapsed(now,pendingSleep.at)>=1500 then
            local seconds=pendingSleep.seconds-2
            pendingSleep=nil
            local ok=pcall(SysNeedInSuperPower)
            if ok then pcall(SysInSuperLowPower,seconds) end
            call(mobile.flymode,0,false); net=-1; seen=nil; ready()
        end
        sys.wait(1000)
    end
end
