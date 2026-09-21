--[[
	HTTP transport to the Nova bridge.

	Roblox Studio plugins have exactly one way to reach a local tool —
	HttpService — so the plugin is always the client: it POSTs requests and
	long-polls for anything Nova wants to send back. The address is always
	loopback; the plugin never contacts anything else.
]]

local HttpService = game:GetService("HttpService")

local Protocol = require(script.Parent.Protocol)

local Transport = {}
Transport.__index = Transport

local POLL_BODY = HttpService:JSONEncode({ poll = true })

function Transport.new(port: number)
	return setmetatable({ host = "127.0.0.1", port = port }, Transport)
end

function Transport:address(): string
	return string.format("%s:%d", self.host, self.port)
end

function Transport:url(path: string): string
	return string.format("http://%s:%d%s", self.host, self.port, path)
end

--[[
	Performs one request. Returns the response, or nil plus a readable reason
	when the request could not be made at all (Nova not running, HTTP blocked).
]]
function Transport:send(path: string, method: string, body: string?, token: string?)
	local headers = { ["Content-Type"] = "application/json" }
	if token then
		headers["X-Nova-Token"] = token
	end

	local options = { Url = self:url(path), Method = method, Headers = headers }
	if body ~= nil then
		options.Body = body
	end

	local ok, response = pcall(function()
		return HttpService:RequestAsync(options)
	end)
	if not ok then
		return nil, tostring(response)
	end
	return response
end

--[[
	Sends a protocol message and returns Nova's decoded reply.
	Returns nil plus a reason on any transport or protocol failure.
]]
function Transport:rpc(message, token: string?)
	local response, err = self:send("/nova/rpc", "POST", Protocol.encode(message), token)
	if not response then
		return nil, err
	end
	if response.StatusCode == 401 then
		return nil, "SESSION_REJECTED"
	end
	if response.StatusCode ~= 200 then
		return nil, string.format("HTTP %d", response.StatusCode)
	end

	local decoded, reason = Protocol.decode(response.Body)
	if not decoded then
		return nil, reason
	end
	return decoded
end

--[[
	Long-polls for the next message Nova has for this session. Returns the raw
	response so the caller can tell "nothing yet" (204) from a lost session
	(401) and from a stopped bridge (503).
]]
function Transport:poll(token: string)
	return self:send("/nova/poll", "POST", POLL_BODY, token)
end

--[[
	Unauthenticated check that something speaking this protocol is listening.
	Used to give a clear reason when a connection attempt fails.
]]
function Transport:info()
	local response, err = self:send("/nova/info", "GET")
	if not response then
		return nil, err
	end
	if response.StatusCode ~= 200 then
		return nil, string.format("HTTP %d", response.StatusCode)
	end

	local ok, decoded = pcall(function()
		return HttpService:JSONDecode(response.Body)
	end)
	if not ok or type(decoded) ~= "table" or decoded.service ~= "nova-studio-bridge" then
		return nil, "NOT_NOVA"
	end
	return decoded
end

return Transport
