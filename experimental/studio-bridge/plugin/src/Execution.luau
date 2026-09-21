--[[
	What happens to a script Nova sends.

	IMPORTANT — the supported boundary.

	A Studio plugin has no supported way to compile and run arbitrary source
	text in the edit session: `loadstring` is not available to plugins, and
	there is no plugin API for submitting text to the command bar. Rather than
	inventing a workaround for that, this plugin stops at the mechanism Studio
	does support and Rojo-style tools rely on: it *delivers* the script into the
	place you have open, as a real Script instance you can read, edit and run
	yourself.

	So "Execute" in Nova means "put this script into my Studio place", and every
	message sent back says exactly that. Nothing here evaluates the source, and
	nothing here touches any process outside Studio.
]]

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Selection = game:GetService("Selection")
local ServerStorage = game:GetService("ServerStorage")

local Protocol = require(script.Parent.Protocol)

local CONTAINER_NAME = "Nova"

local Execution = {}
Execution.__index = Execution

function Execution.new(plugin: Plugin)
	return setmetatable({ plugin = plugin, active = {} }, Execution)
end

--[[
	Instance names are not paths: strip the .lua extension Nova uses and remove
	anything Studio would not accept in a name.
]]
local function instanceName(scriptName: string): string
	local cleaned = string.gsub(scriptName, "%.luau?$", "")
	cleaned = string.gsub(cleaned, "[^%w %-_%.]", "")
	cleaned = string.gsub(cleaned, "^%s+", "")
	cleaned = string.gsub(cleaned, "%s+$", "")
	if #cleaned > 80 then
		cleaned = string.sub(cleaned, 1, 80)
	end
	if cleaned == "" then
		cleaned = "NovaScript"
	end
	return cleaned
end

--[[
	The folder delivered scripts land in. Scripts in ServerStorage do not run on
	their own, so nothing starts executing because Nova sent it.
]]
local function container(): Folder
	local existing = ServerStorage:FindFirstChild(CONTAINER_NAME)
	if existing and existing:IsA("Folder") then
		return existing
	end

	local folder = Instance.new("Folder")
	folder.Name = CONTAINER_NAME
	folder.Parent = ServerStorage
	return folder
end

local function countLines(source: string): number
	local _, newlines = string.gsub(source, "\n", "")
	return newlines + 1
end

--[[
	Delivers one request. `report` receives progress the same way Nova's own
	providers do: started, output lines, then exactly one result or failure.
]]
function Execution:run(payload: { [string]: any }, report)
	local code, detail = Protocol.validateExecuteRequest(payload)
	if code then
		report.failed(code, detail)
		return
	end

	local executionId = payload.executionId
	self.active[executionId] = true
	report.started()

	local name = instanceName(payload.scriptName)
	local folder = container()
	local existing = folder:FindFirstChild(name)
	local target = if existing and existing:IsA("Script") then existing else nil
	local created = target == nil

	-- One undo waypoint, so a delivery can be reverted in Studio like any edit.
	local recording = nil
	local beganOk, beganId = pcall(function()
		return ChangeHistoryService:TryBeginRecording("Nova: deliver " .. name)
	end)
	if beganOk then
		recording = beganId
	end

	local ok, err = pcall(function()
		if target == nil then
			target = Instance.new("Script")
			target.Name = name
		end
		target.Source = payload.source
		if created then
			target.Parent = folder
		end
	end)

	if recording then
		pcall(function()
			ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
		end)
	end

	self.active[executionId] = nil

	if not ok then
		local message = tostring(err)
		if string.find(message, "Source", 1, true) or string.find(message, "permission", 1, true) then
			report.failed(
				"STUDIO_PERMISSION_DENIED",
				"Studio did not let the plugin write script source. Allow script injection for the Nova plugin in Plugins › Manage Plugins, then try again."
			)
		else
			report.failed("STUDIO_WRITE_FAILED", message)
		end
		return
	end

	if created then
		pcall(function()
			Selection:Set({ target })
			self.plugin:OpenScript(target)
		end)
	end

	local path = target:GetFullName()
	report.output(
		"info",
		string.format("%s %s (%d lines)", if created then "Created" else "Updated", path, countLines(payload.source))
	)
	report.output(
		"warn",
		"Delivered only: Studio plugins cannot run arbitrary source, so the script was not executed. Open or move it to run it yourself."
	)
	report.result(string.format("Delivered to %s (%d lines, not executed).", path, countLines(payload.source)))
end

--[[
	Cancellation. Delivery is a single synchronous write with nothing to
	interrupt, so this reports honestly rather than claiming a cancellation that
	did not happen.
]]
function Execution:cancel(executionId: string): string
	if not self.active[executionId] then
		return "UNKNOWN_REQUEST"
	end
	return "CANCEL_UNSUPPORTED"
end

return Execution
