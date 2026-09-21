--[[
	The plugin side of the bridge session: handshake, pairing, the receive loop,
	heartbeat answers and disconnection.

	The plugin only ever connects to loopback, and only after the user has typed
	a pairing code that Nova generated. A dropped session is never silently
	re-established with a remembered secret: the session token lives in memory
	for this session only, and a lost connection means pairing again.
]]

local Protocol = require(script.Parent.Protocol)

local Connection = {}
Connection.__index = Connection

-- Retry a failing poll a few times before giving up, with growing waits so a
-- stopped Nova is not hammered.
local RETRY_WAITS = { 1, 2, 4, 8 }
-- How long the session may go without a successful exchange before it is over.
local CONTACT_GRACE_SECONDS = 45

export type State = "disconnected" | "connecting" | "connected"

function Connection.new(options)
	return setmetatable({
		transport = options.transport,
		execution = options.execution,
		onChange = options.onChange or function() end,
		onLog = options.onLog or function() end,
		state = "disconnected" :: State,
		detail = "Not connected",
		sessionId = nil,
		serverVersion = nil,
		token = nil,
		generation = 0,
		lastContact = 0,
	}, Connection)
end

function Connection:setState(state: State, detail: string)
	self.state = state
	self.detail = detail
	self.onChange(self)
end

function Connection:isConnected(): boolean
	return self.state == "connected"
end

--[[
	Sends one message and returns Nova's reply. Sends are short and sequential
	within a caller, so execution progress arrives in order.
]]
function Connection:send(messageType: string, payload, requestId: string?)
	return self.transport:rpc(Protocol.envelope(messageType, payload, requestId), self.token)
end

function Connection:endSession(detail: string)
	self.generation += 1
	self.token = nil
	self.sessionId = nil
	self:setState("disconnected", detail)
end

--[[
	Handshake, then pair with the code the user read from Nova.
]]
function Connection:connect(code: string)
	if self.state ~= "disconnected" then
		return
	end
	if type(code) ~= "string" or not string.match(code, "^%d%d%d%d%d%d$") then
		self:setState("disconnected", "Enter the six digit code shown in Nova.")
		return
	end

	self:setState("connecting", "Contacting Nova…")
	self.generation += 1
	local generation = self.generation

	local info, infoError = self.transport:info()
	if not info then
		self:setState(
			"disconnected",
			string.format(
				"No Nova bridge on %s (%s). Start the bridge in Nova and check the port.",
				self.transport:address(),
				tostring(infoError)
			)
		)
		return
	end
	if info.protocol ~= Protocol.VERSION then
		self:setState(
			"disconnected",
			string.format(
				"Nova speaks %s; this plugin speaks %s. Update the older side.",
				tostring(info.protocol),
				Protocol.VERSION
			)
		)
		return
	end

	local hello, helloError = self:send("hello", {
		clientType = Protocol.CLIENT_TYPE,
		clientVersion = Protocol.PLUGIN_VERSION,
		protocolVersion = Protocol.VERSION,
		capabilities = Protocol.CAPABILITIES,
	})
	if not hello then
		self:setState("disconnected", string.format("Nova did not answer the handshake (%s).", tostring(helloError)))
		return
	end
	if hello.type ~= "hello_ack" then
		self:setState("disconnected", "Nova refused the handshake.")
		return
	end
	if hello.payload.busy then
		self:setState("disconnected", "Nova is already connected to another Studio session.")
		return
	end
	self.serverVersion = tostring(hello.payload.serverVersion)

	local paired, pairError = self:send("pair_request", {
		code = code,
		clientType = Protocol.CLIENT_TYPE,
		clientVersion = Protocol.PLUGIN_VERSION,
		capabilities = Protocol.CAPABILITIES,
	})
	if self.generation ~= generation then
		return
	end
	if not paired then
		self:setState("disconnected", string.format("Pairing failed (%s).", tostring(pairError)))
		return
	end
	if paired.type ~= "pair_response" or not paired.payload.ok then
		local reason = "Pairing was refused."
		local errorPayload = paired.payload.error
		if type(errorPayload) == "table" and errorPayload.code == "PAIRING_EXPIRED" then
			reason = "That code has expired. Ask Nova for a new one."
		elseif type(errorPayload) == "table" and errorPayload.code == "AUTHENTICATION_FAILED" then
			reason = "That code is not right. Check the code shown in Nova."
		elseif type(errorPayload) == "table" and errorPayload.code == "SESSION_REPLACED" then
			reason = "Nova is already connected to another Studio session."
		end
		self:setState("disconnected", reason)
		return
	end
	if type(paired.payload.sessionToken) ~= "string" or type(paired.payload.sessionId) ~= "string" then
		self:setState("disconnected", "Nova's pairing reply was malformed.")
		return
	end

	self.token = paired.payload.sessionToken
	self.sessionId = paired.payload.sessionId
	self.lastContact = os.time()
	self:setState("connected", "Connected to Nova " .. tostring(self.serverVersion))
	self.onLog("Paired with Nova; session " .. string.sub(self.sessionId, 1, 8))

	task.spawn(function()
		self:receiveLoop(generation)
	end)
end

function Connection:disconnect(reason: string?)
	if self.state == "disconnected" then
		return
	end
	if self.token then
		-- Best effort: tell Nova before dropping the session.
		pcall(function()
			self:send("disconnect", { reason = reason or "The Studio plugin disconnected." })
		end)
	end
	self:endSession(reason or "Disconnected")
end

--[[
	Waits for messages Nova pushes. Each poll is held open by the bridge, so an
	idle session costs one parked request rather than repeated polling.
]]
function Connection:receiveLoop(generation: number)
	local failures = 0

	while self.generation == generation and self.state == "connected" do
		local response, err = self.transport:poll(self.token)
		if self.generation ~= generation then
			return
		end

		if response and response.StatusCode == 200 then
			failures = 0
			self.lastContact = os.time()
			self:handle(response.Body)
		elseif response and response.StatusCode == 204 then
			failures = 0
			self.lastContact = os.time()
		elseif response and response.StatusCode == 401 then
			self:endSession("Nova ended the session. Pair again to reconnect.")
			return
		elseif response and response.StatusCode == 503 then
			self:endSession("Nova stopped the bridge.")
			return
		else
			failures += 1
			local reason = if response then string.format("HTTP %d", response.StatusCode) else tostring(err)
			if os.time() - self.lastContact > CONTACT_GRACE_SECONDS then
				self:endSession(string.format("Lost contact with Nova (%s). Pair again to reconnect.", reason))
				return
			end
			self:setState("connected", string.format("Reconnecting… (%s)", reason))
			task.wait(RETRY_WAITS[math.min(failures, #RETRY_WAITS)])
		end
	end
end

function Connection:handle(body: string)
	local message, reason = Protocol.decode(body)
	if not message then
		self.onLog("Ignored a message from Nova: " .. tostring(reason))
		return
	end

	if message.type == "ping" then
		task.spawn(function()
			self:send("pong", { sessionId = self.sessionId }, message.requestId)
		end)
	elseif message.type == "disconnect" then
		local reasonText = message.payload.reason
		self:endSession(if type(reasonText) == "string" then reasonText else "Nova closed the session.")
	elseif message.type == "execute_request" then
		self:runExecution(message)
	elseif message.type == "execute_cancel" then
		self:handleCancel(message)
	elseif message.type == "error" then
		self.onLog("Nova reported: " .. tostring(message.payload.message))
	else
		self.onLog("Ignored an unsupported message: " .. message.type)
	end
end

function Connection:runExecution(message)
	local payload = message.payload
	local executionId = payload.executionId

	task.spawn(function()
		local report = {
			started = function()
				self:send("execute_started", { executionId = executionId }, executionId)
			end,
			output = function(level: string, text: string)
				self:send("execute_output", { executionId = executionId, level = level, message = text }, executionId)
			end,
			result = function(summary: string)
				self:send(
					"execute_result",
					{ executionId = executionId, status = "success", outputSummary = summary },
					executionId
				)
			end,
			failed = function(code: string, detail: string)
				self:send(
					"execute_error",
					{ executionId = executionId, error = { code = code, message = detail } },
					executionId
				)
			end,
		}

		local ok, err = pcall(function()
			self.execution:run(payload, report)
		end)
		if not ok then
			-- A failure inside the plugin must still end the execution in Nova.
			pcall(function()
				report.failed("STUDIO_PLUGIN_ERROR", tostring(err))
			end)
		end
	end)
end

function Connection:handleCancel(message)
	local executionId = message.payload.executionId
	if type(executionId) ~= "string" then
		return
	end

	local verdict = self.execution:cancel(executionId)
	task.spawn(function()
		self:send("error", {
			code = verdict,
			message = if verdict == "CANCEL_UNSUPPORTED"
				then "Delivering a script is a single write and cannot be interrupted."
				else "No such execution is running in Studio.",
			executionId = executionId,
		}, message.requestId)
	end)
end

return Connection
