--[[
	Nova Studio Bridge — plugin entry point.

	Connects the place you have open in Studio to Nova running on this machine,
	over loopback only, after you pair the two with a code Nova shows you.

	The plugin does not run scripts Nova sends: Studio has no supported way to
	execute arbitrary source from a plugin, so scripts are delivered into the
	open place as Script instances (see Execution.luau). Nothing outside Studio
	is contacted and no process is inspected.
]]

local RunService = game:GetService("RunService")

local Connection = require(script.Connection)
local Execution = require(script.Execution)
local Protocol = require(script.Protocol)
local Transport = require(script.Transport)
local Ui = require(script.Ui)

-- Plugins load into the edit session and into each play-test session. Only the
-- edit session owns the bridge, so play-testing never opens a second one.
if not RunService:IsEdit() then
	return
end

local PORT_SETTING = "nova.bridge.port"
local DEFAULT_PORT = 46682

local function readPort(): number
	local stored = plugin:GetSetting(PORT_SETTING)
	if type(stored) == "number" and stored >= 1024 and stored <= 49151 then
		return math.floor(stored)
	end
	return DEFAULT_PORT
end

local port = readPort()
local transport = Transport.new(port)
local execution = Execution.new(plugin)
local ui

local connection = Connection.new({
	transport = transport,
	execution = execution,
	onChange = function(state)
		if ui then
			ui:render({
				state = state.state,
				detail = state.detail,
				sessionId = state.sessionId,
				protocolVersion = Protocol.VERSION,
			})
		end
	end,
	onLog = function(message)
		print("[Nova] " .. message)
	end,
})

ui = Ui.new(plugin, {
	port = port,
	getPort = function()
		return port
	end,
	onPortChange = function(nextPort: number)
		port = nextPort
		transport.port = nextPort
		plugin:SetSetting(PORT_SETTING, nextPort)
	end,
	onConnect = function(code: string)
		connection:connect((string.gsub(code, "%s", "")))
	end,
	onDisconnect = function()
		connection:disconnect("Disconnected from Studio.")
	end,
})

local toolbar = plugin:CreateToolbar("Nova")
local button =
	toolbar:CreateButton("Nova Bridge", "Connect this place to Nova", "rbxasset://textures/ui/common/robux.png")
button.ClickableWhenViewportHidden = true
button.Click:Connect(function()
	ui:toggle()
	button:SetActive(ui.widget.Enabled)
end)

connection.onChange(connection)

plugin.Unloading:Connect(function()
	-- Leave nothing behind: tell Nova, stop the receive loop, drop the UI.
	connection:disconnect("The Studio plugin was unloaded.")
	ui:destroy()
end)
