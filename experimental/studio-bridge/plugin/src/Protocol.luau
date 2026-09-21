--[[
	The wire protocol, mirroring src/features/bridge/protocol.ts in Nova.

	Both sides validate every message they receive. The plugin treats Nova as
	untrusted input just as Nova treats the plugin: a malformed or unexpected
	message is refused, never acted on.
]]

local HttpService = game:GetService("HttpService")

local Protocol = {}

Protocol.VERSION = "NOVA_STUDIO_BRIDGE_V1"
Protocol.PLUGIN_VERSION = "1.0.0"
Protocol.CLIENT_TYPE = "roblox-studio-plugin"
Protocol.MAX_SOURCE_BYTES = 2 * 1024 * 1024

-- What this plugin can actually do, announced during the handshake. Nothing
-- here evaluates code: Studio plugins have no supported way to run arbitrary
-- source, so the plugin delivers scripts into the open place instead.
Protocol.CAPABILITIES = { "deliver-script", "output", "cancel" }

function Protocol.envelope(messageType: string, payload: { [string]: any }?, requestId: string?)
	local body = payload or {}
	-- JSONEncode turns an empty Lua table into `[]`, which is not a valid
	-- payload object, so every message carries at least one field.
	if next(body) == nil then
		body = { client = Protocol.CLIENT_TYPE }
	end

	local message = {
		protocol = Protocol.VERSION,
		type = messageType,
		messageId = HttpService:GenerateGUID(false),
		timestamp = DateTime.now().UnixTimestampMillis,
		payload = body,
	}
	if requestId then
		message.requestId = requestId
	end
	return message
end

function Protocol.encode(message): string
	return HttpService:JSONEncode(message)
end

--[[
	Parses and validates an inbound message. Returns the message, or nil plus a
	structured reason.
]]
function Protocol.decode(body: any)
	if type(body) ~= "string" or body == "" then
		return nil, "INVALID_MESSAGE"
	end

	local ok, decoded = pcall(function()
		return HttpService:JSONDecode(body)
	end)
	if not ok or type(decoded) ~= "table" then
		return nil, "INVALID_MESSAGE"
	end
	if decoded.protocol ~= Protocol.VERSION then
		return nil, "UNSUPPORTED_PROTOCOL"
	end
	if type(decoded.type) ~= "string" or decoded.type == "" then
		return nil, "INVALID_MESSAGE"
	end
	if type(decoded.messageId) ~= "string" or decoded.messageId == "" then
		return nil, "INVALID_MESSAGE"
	end
	if type(decoded.payload) ~= "table" then
		return nil, "INVALID_MESSAGE"
	end
	if decoded.requestId ~= nil and type(decoded.requestId) ~= "string" then
		return nil, "INVALID_MESSAGE"
	end

	return decoded
end

--[[
	Checks an execution request before anything is written into the place. The
	plugin is a security boundary: it never assumes Nova sent something sane.
]]
function Protocol.validateExecuteRequest(payload: { [string]: any })
	if type(payload.executionId) ~= "string" or payload.executionId == "" then
		return "INVALID_EXECUTION_REQUEST", "The request carries no execution id."
	end
	if type(payload.scriptName) ~= "string" or payload.scriptName == "" then
		return "INVALID_EXECUTION_REQUEST", "The request carries no script name."
	end
	if payload.mode ~= "full-script" and payload.mode ~= "selection" then
		return "INVALID_EXECUTION_REQUEST", "The request mode is not supported."
	end
	if type(payload.source) ~= "string" then
		return "INVALID_EXECUTION_REQUEST", "The request carries no source text."
	end
	if #payload.source > Protocol.MAX_SOURCE_BYTES then
		return "REQUEST_TOO_LARGE",
			string.format(
				"The script is %d KB; this bridge accepts up to %d KB.",
				math.floor(#payload.source / 1024),
				math.floor(Protocol.MAX_SOURCE_BYTES / 1024)
			)
	end
	return nil
end

return Protocol
