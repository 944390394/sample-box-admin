# DTU 模板（银尔达 M100MG-C2，分组参数 → 数据流模版 / 任务）

**STM32 1.0.17 按周期定位试验箱**使用单 TCP 通道 1、TTL 串口 1（9600 8N1）。清空“接收数据模板”和“发送数据模板”，将 [sampling-task.lua](../firmware/dtu/sampling-task.lua) 全文作为唯一“任务模板”。该任务接管双向转发、定位和链路通知。下面第 1–4 节保留给原有分组。保存前请备份原分组配置，重启后检查上报中有 `lpp=1`、`fw=1.0.17` 和 `rn=1`，并核对后台下发周期与设备回显。

模板在 DTU 平台（https://dtu.yinerda.com）的分组参数里配置，不在服务器代码里。粘贴时注意：

- 先在本地文档里编辑，再一次性整段粘贴，不要在浏览器框里改。
- 第一行必须是 `function`，最后一行必须是 `end`，前后不能有空格。
- 保存参数后重启模块，等 20 到 30 秒更新。
- 模板出错可能让模块反复重启：按住 Reload 键再上电，保持 7 秒以上恢复出厂。
- **串口波特率**：STM 固件 1.0.14 起是 9600（单片机要能被串口数据从休眠里叫醒，115200 太快），DTU 平台的串口参数必须同样设成 9600、8 位数据、无校验、1 位停止位。1.0.13 及以前是 115200。两边不一致时箱子和模块完全不通。

## 1. 发送数据模版（通道 1，串口 → 服务器）

2026-10-29 起多了 GPS 扩展信息：定位成功时再带航向 `course`、GPS 时间 `gpstime`、海拔 `alt`、卫星数 `sats`、水平精度因子 `hdop`（服务器 2026.10.29 之后的版本才读，旧服务器会忽略）。没定位时这些字段不出现，不多耗流量；一包大约多 60 字节。`gpstime` 是 GPS 给的 UTC 时间。`speed` 的单位以银尔达/合宙文档为准，服务器原样保存不换算。

更早一版和之前上线的相比，只去掉了 `d.uarthex` 那一行：它把串口内容再用十六进制发一遍，服务器代码里没有任何地方读它，去掉后每条上传少约三分之一流量，数据库里存的原文也变小。粘贴时整段替换发送数据模版，保存后重启模块。

```lua
function
	local str = ... or ""
	local function take(f)
		local ok, v = pcall(f)
		if ok then
			return v
		end
		return ""
	end
	local function field(name)
		local found = string.match(str, "[,\r\n]" .. name .. "=([^,\r\n]*)")
			or string.match(str, "^" .. name .. "=([^,\r\n]*)")
		if found then
			found = string.gsub(found, "%s+$", "")
		end
		return found
	end
	local function numberOrText(value)
		local n = tonumber(value)
		if n then
			return n
		end
		return value
	end

	local d = {}
	d.uart = str
	d.imei = take(function() return mobile.imei() end)
	d.iccid = take(function() return mobile.iccid() end)
	d.imsi = take(function() return mobile.imsi() end)
	d.csq = take(function() return mobile.csq() end)
	d.time = os.date("%Y-%m-%d %H:%M:%S")
	d.timem = tostring(os.time()) .. "000"

	local bat = field("bat")
	if bat and bat ~= "" then
		d.vbat = numberOrText(bat)
	else
		d.vbat = take(function() return PerGetVbattV() end)
	end
	local chg = field("chg")
	if chg and chg ~= "" then
		d.chg = numberOrText(chg)
	end
	local lid = field("lid")
	if lid and lid ~= "" then
		d.lid = numberOrText(lid)
	end
	local opens = field("opens")
	if opens and opens ~= "" then
		d.opens = numberOrText(opens)
	end

	d.gpsfix = 0
	pcall(function()
		if libgnss.isFix() then
			local tg = libgnss.getRmc(2)
			d.gpsfix = 1
			d.lng = tg.lng
			d.lat = tg.lat
			d.speed = tg.speed
			d.course = tg.course
			if tg.year and tg.year > 2000 then
				d.gpstime = string.format("%04d-%02d-%02d %02d:%02d:%02d", tg.year, tg.month, tg.day, tg.hour, tg.min, tg.sec)
			end
		end
	end)
	pcall(function()
		if d.gpsfix == 1 then
			local ga = libgnss.getGga(2)
			d.alt = ga.altitude
			d.sats = ga.satellites_tracked
			d.hdop = ga.hdop
		end
	end)
	pcall(function()
		local lng, lat = GetLbs()
		d.lbslng = lng
		d.lbslat = lat
	end)
	return json.encode(d)
end
```

## 2. 接收数据模版（服务器 → 串口）

### 2a. 现在用这份：留空

留空就是原样透传，策略、`ok` 确认、抹除和导出指令都靠它，已经实测可用。**在 3b 任务模版和固件 1.0.8 都生效之前，必须留空。**

不要提前调用 `PerSetLedSta`：它控制的是模块全部的灯，包括和 RDY 引脚相连的 RDY 灯，RDY 变低后固件会以为模块断网，停止上报。2026-10-28 实测出现过。

### 2b. 模块灯版（固件 1.0.8 和 3b 任务模版都生效，并且上报里出现 `rn=1` 之后再粘贴）

服务器只有在设备上报 `rn=1`、并且网页上选了“日常亮”或“日常灭”时，才会在确认行末尾加 ` m=0|1`，例如 `ok p=60 c=0 l=1 a=12 v=987 m=0`。这段模板读出 `m=` 调用 `PerSetLedSta`，整行原样还给串口，STM 解析到未知的 `m=` 会停下，此时 `v=` 已经应用。

```lua
function
	local s = ... or ""
	local m = string.match(s, " m=([01])")
	if m then
		pcall(function()
			local want = tonumber(m)
			if PerGetLedSta() ~= want then
				PerSetLedSta(want)
			end
		end)
	end
	return s
end
```

关灯后 RDY 引脚会变低，但固件 1.0.8 以后看的是 3b 发来的 `net=`，不再受影响。`PerSetLedSta` 关灯后最多 10 秒才真正熄灭；它在 M100MG-C2 上是否真的控制 NET 和 RDY 灯要实测。DTU 分组参数里的“关闭LED指示”先保持“正常模式”，避免两者互相干扰。

## 3. 任务模版

### 3a. 当前线上版本（固件 1.0.7 及以前用这份）

和现在用的相同，没有改动。联网后对时，并把 `ntp=<毫秒>` 写给 STM。

```lua
function
	local nid = 1
	local uid = 1

	local reason, slp = 0, 0
	pcall(function()
		reason, slp = pm.lastReson()
	end)
	if slp and slp > 0 then
		mobile.flymode(0, false)
	end

	local n = 0
	while n < 60 do
		if PronetGetNetSta(nid) == 1 then
			break
		end
		n = n + 1
		sys.wait(1000)
	end

	if PronetGetNetSta(nid) == 1 then
		pcall(function()
			if socket and socket.ntpSync then
				socket.ntpSync()
			elseif ntp and ntp.timeSync then
				ntp.timeSync()
			end
		end)
	end
	if os.time() > 1700000000 then
		pcall(function()
			uart.write(uid, "ntp=" .. tostring(os.time()) .. "000\r\n")
		end)
	end

	while true do
		sys.wait(1000)
	end
end
```

### 3b. 链路状态版（等固件 1.0.8 烧录后再粘贴，不要提前）

在 3a 的基础上：开机最先写 `net=0`；之后每 2 秒看一次通道 1 是否连上服务器，状态一变立刻写 `net=1` 或 `net=0`，在线时每 60 秒再补一次。STM 以它为准判断模块是否在线，不再依赖 RDY 引脚，所以以后关模块灯不会影响上报。不需要 STM 回复。

```lua
function
	local nid = 1
	local uid = 1

	pcall(function()
		uart.write(uid, "net=0\r\n")
	end)

	local reason, slp = 0, 0
	pcall(function()
		reason, slp = pm.lastReson()
	end)
	if slp and slp > 0 then
		mobile.flymode(0, false)
	end

	local n = 0
	while n < 60 do
		if PronetGetNetSta(nid) == 1 then
			break
		end
		n = n + 1
		sys.wait(1000)
	end

	if PronetGetNetSta(nid) == 1 then
		pcall(function()
			if socket and socket.ntpSync then
				socket.ntpSync()
			elseif ntp and ntp.timeSync then
				ntp.timeSync()
			end
		end)
	end
	if os.time() > 1700000000 then
		pcall(function()
			uart.write(uid, "ntp=" .. tostring(os.time()) .. "000\r\n")
		end)
	end

	local last = -1
	local idle = 0
	while true do
		local up = 0
		pcall(function()
			if PronetGetNetSta(nid) == 1 then
				up = 1
			end
		end)
		idle = idle + 1
		if up ~= last or (up == 1 and idle >= 30) then
			pcall(function()
				uart.write(uid, "net=" .. tostring(up) .. "\r\n")
			end)
			last = up
			idle = 0
		end
		sys.wait(2000)
	end
end
```

## 4. 优化版（2026-11，先在一台箱子上试，没问题再全量）

解决两件事：**GPS 出得慢**、**每次发送卡在基站定位上**。上面 1～3 节的旧版本保留，出问题直接换回去。

改了什么：

1. **基站定位不阻塞发送**：任务模版在后台刷新基站位置（没 GPS 时 5 分钟一次，有 GPS 时 30 分钟一次）。发送数据模版只读缓存，不再每发一条就调 `GetLbs()`。手册中最长 60 秒的说明属于主动定位 LbsCheckLbs()。GetLbs() 读取定位结果，DTU 后台发起定位的频率需查分组配置。
2. **定位一成功就记住**：任务模版每 2 秒看一次定位，定位成功就记下坐标和时间。发送数据模版在此刻没定位、但 10 分钟内定位过时，带上 `glng / glat / gat`（上次的坐标和秒级时间）。服务器 2026.11 之后的版本按 `gat` 记成那个时间的 GPS 位置，页面显示「几分钟前定位」。
3. **定位电源按需开**：服务器在确认行末尾带 ` g=1/0`。有进行中的任务或在充电时为 1，GNSS 保持上电，热启动几秒就能定位；空闲时为 0，断电省电。接收数据模版读出来以后把它从行里删掉，STM 收不到。
4. **AGPS（可选，默认关）**：联网后下载辅助星历写给定位芯片，冷启动能缩短到十几秒。不同模块写星历的串口和接口不一样，先在一台箱子上把 `AGPS = true` 实测。
5. **首次定位通知 STM（默认关）**：定位成功时给 STM 写 `gps=1`，让它马上发一条带坐标的上报。固件 1.0.11（2026-11-03 烧录）起支持：收到后马上补一条定时上报，两次至少隔 1 分钟。箱子都升到 1.0.11 后可以改成 `NOTIFY_STM = true`；老固件收到这行会直接丢弃，不受影响。
6. 原来的 `net=` 链路状态和对时不变。

**需要和银尔达工程师核对或实测的地方**：

- 全局变量 `_G.YED_*` 能否在任务模版和发送、接收模版之间共享；
- `GpsSetPower(0/1)`；
- 定位芯片串口号 `GPS_UART`；
- `libgnss.casic_aid`。

所有调用都包在 `pcall` 里。函数不存在时只是那一项不生效，其余照常；但全局变量不共享的话，第 1、2 点就不起作用。

### 4a. 发送数据模版

```lua
function
	local str = ... or ""
	local function take(f)
		local ok, v = pcall(f)
		if ok then return v end
		return ""
	end
	local function field(name)
		local found = string.match(str, "[,\r\n]" .. name .. "=([^,\r\n]*)") or string.match(str, "^" .. name .. "=([^,\r\n]*)")
		if found then found = string.gsub(found, "%s+$", "") end
		return found
	end
	local function num(v)
		return tonumber(v) or v
	end

	local d = {}
	d.uart = str
	d.imei = take(function() return mobile.imei() end)
	d.iccid = take(function() return mobile.iccid() end)
	d.imsi = take(function() return mobile.imsi() end)
	d.csq = take(function() return mobile.csq() end)
	d.time = os.date("%Y-%m-%d %H:%M:%S")
	d.timem = tostring(os.time()) .. "000"
	for _, k in ipairs({ "bat", "chg", "lid", "opens" }) do
		local v = field(k)
		if v and v ~= "" then d[k == "bat" and "vbat" or k] = num(v) end
	end
	if d.vbat == nil then d.vbat = take(function() return PerGetVbattV() end) end

	d.gpsfix = 0
	pcall(function()
		if not _G.YED_GNSS_OFF and libgnss.isFix() then
			local tg = libgnss.getRmc(2)
			d.gpsfix = 1
			d.lng, d.lat, d.speed, d.course = tg.lng, tg.lat, tg.speed, tg.course
			if tg.year and tg.year > 2000 then
				d.gpstime = string.format("%04d-%02d-%02d %02d:%02d:%02d", tg.year, tg.month, tg.day, tg.hour, tg.min, tg.sec)
			end
			local ga = libgnss.getGga(2)
			d.alt, d.sats, d.hdop = ga.altitude, ga.satellites_tracked, ga.hdop
		end
	end)
	if d.gpsfix == 0 then
		local f = _G.YED_FIX
		if f and os.time() - f.t <= 600 then
			d.glng, d.glat, d.gat = f.lng, f.lat, f.t
		end
	end

	local l = _G.YED_LBS
	if l then
		d.lbslng, d.lbslat = l.lng, l.lat
	end
	return json.encode(d)
end
```

### 4b. 接收数据模版

在「模块灯版」（2b）的基础上，多读 ` g=` 并把它从行里删掉。如果现在接收数据模版还是留空，就去掉 `m=` 那一段，只留处理 `g=` 的部分。

```lua
function
	local s = ... or ""
	local m = string.match(s, " m=([01])")
	if m then
		pcall(function()
			local want = tonumber(m)
			if PerGetLedSta() ~= want then PerSetLedSta(want) end
		end)
	end
	local g = string.match(s, " g=([01])")
	if g then
		_G.YED_GNSS_WANT = tonumber(g)
		s = string.gsub(s, " g=[01]", "")
	end
	return s
end
```

### 4c. 任务模版（在 3b 链路状态版的基础上扩展）

```lua
function
	local nid, uid = 1, 1
	local AGPS = false
	local NOTIFY_STM = false
	local GPS_UART = 2

	pcall(function() uart.write(uid, "net=0\r\n") end)
	local reason, slp = 0, 0
	pcall(function() reason, slp = pm.lastReson() end)
	if slp and slp > 0 then mobile.flymode(0, false) end

	local n = 0
	while n < 60 and PronetGetNetSta(nid) ~= 1 do
		n = n + 1
		sys.wait(1000)
	end
	if PronetGetNetSta(nid) == 1 then
		pcall(function()
			if socket and socket.ntpSync then socket.ntpSync() elseif ntp and ntp.timeSync then ntp.timeSync() end
		end)
	end
	if os.time() > 1700000000 then
		pcall(function() uart.write(uid, "ntp=" .. tostring(os.time()) .. "000\r\n") end)
	end

	if AGPS and PronetGetNetSta(nid) == 1 then
		pcall(function()
			local code, _, body = http.request("GET", "http://download.openluat.com/9501-xingli/HXXT_GPS_BDS_AGNSS_DATA.dat").wait()
			if code == 200 and body and #body > 1024 then
				if libgnss.casic_aid and _G.YED_LBS then
					uart.write(GPS_UART, libgnss.casic_aid(os.date("!*t"), { lat = _G.YED_LBS.lat, lng = _G.YED_LBS.lng }))
				end
				for i = 1, #body, 512 do
					uart.write(GPS_UART, string.sub(body, i, i + 511))
					sys.wait(50)
				end
			end
		end)
	end

	local last, idle, tick = -1, 0, 0
	local lbsAt, fixed, gnssOn = 0, false, -1
	local failedWant, retryAt = nil, 0
	while true do
		local up = 0
		pcall(function() if PronetGetNetSta(nid) == 1 then up = 1 end end)
		idle = idle + 1
		if up ~= last or (up == 1 and idle >= 30) then
			pcall(function() uart.write(uid, "net=" .. tostring(up) .. "\r\n") end)
			last, idle = up, 0
		end

		local want = _G.YED_GNSS_WANT
		if want ~= nil and want ~= gnssOn and (want ~= failedWant or tick >= retryAt) then
			local called, result = pcall(GpsSetPower, want)
			if called and result ~= false then
				gnssOn = want
				_G.YED_GNSS_OFF = want == 0
				failedWant = nil
			else
				gnssOn = -1
				_G.YED_GNSS_OFF = false
				failedWant, retryAt = want, tick + 30
			end
		end

		local ok = false
		pcall(function()
			if gnssOn ~= 0 and libgnss.isFix() then
				local tg = libgnss.getRmc(2)
				_G.YED_FIX = { lng = tg.lng, lat = tg.lat, t = os.time() }
				ok = true
			end
		end)
		if ok and not fixed and NOTIFY_STM then
			pcall(function() uart.write(uid, "gps=1\r\n") end)
		end
		fixed = ok

		tick = tick + 2
		if up == 1 and (lbsAt == 0 or tick - lbsAt >= (fixed and 1800 or 300)) then
			pcall(function()
				local lng, lat = GetLbs()
				if lng and lat and tonumber(lng) and tonumber(lng) ~= 0 then
					_G.YED_LBS = { lng = lng, lat = lat }
				end
			end)
			lbsAt = tick
		end
		sys.wait(2000)
	end
end
```

### 4d. 试用时怎么看效果

本版在关 GNSS 调用正常返回后暂停定位状态读取，保留最近一次定位供原有 10 分钟回退逻辑使用。同一电源指令调用异常或明确返回 false 时，约 30 秒后重试，方向改变可在下一轮处理。手册没有定义供电状态回读，实际关电仍需测电流。4a 与 4c 应配套，且模板之间需要共享全局变量。

设备空闲后分别抓取 STM 发给 DTU 的首帧、DTU 转给 STM 的首个确认包，检查 pv/rp/rc 回显和 a= 队列确认。在带任务、空闲电池和重新接入充电三种状态下检查定位恢复及整机平均电流。

对比旧模板，看这几项：

- 从开机到地图上出现第一个 GPS 点用了多久；
- 每次发送的耗时（服务端系统日志里的处理时间）；
- 一天的流量；
- 断网几分钟再恢复后，补传的条数是否和设备队列一致。
