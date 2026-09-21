--[[
	The Studio-side panel: a compact status surface, the loopback port, the
	pairing code field and one action. It deliberately does not rebuild Nova's
	interface inside Studio — scripts are written in Nova, not here.
]]

local Ui = {}
Ui.__index = Ui

local function color(styleGuideColor: Enum.StudioStyleGuideColor, modifier: Enum.StudioStyleGuideModifier?)
	return settings().Studio.Theme:GetColor(styleGuideColor, modifier)
end

local function create(className: string, properties: { [string]: any }, parent: Instance?)
	local instance = Instance.new(className)
	for key, value in properties do
		instance[key] = value
	end
	if parent then
		instance.Parent = parent
	end
	return instance
end

local function label(text: string, size: number, parent: Instance, order: number, bold: boolean?)
	return create("TextLabel", {
		Text = text,
		Font = if bold then Enum.Font.GothamBold else Enum.Font.Gotham,
		TextSize = size,
		TextXAlignment = Enum.TextXAlignment.Left,
		TextWrapped = true,
		BackgroundTransparency = 1,
		Size = UDim2.new(1, 0, 0, size + 6),
		AutomaticSize = Enum.AutomaticSize.Y,
		LayoutOrder = order,
	}, parent)
end

function Ui.new(plugin: Plugin, options)
	local self = setmetatable({ plugin = plugin, options = options, elements = {} }, Ui)

	local widget = plugin:CreateDockWidgetPluginGui(
		"NovaStudioBridge",
		DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, false, false, 280, 340, 240, 280)
	)
	widget.Title = "Nova"
	widget.Name = "NovaStudioBridge"
	self.widget = widget

	local root = create("Frame", {
		Size = UDim2.fromScale(1, 1),
		BorderSizePixel = 0,
	}, widget)
	create("UIPadding", {
		PaddingTop = UDim.new(0, 12),
		PaddingBottom = UDim.new(0, 12),
		PaddingLeft = UDim.new(0, 12),
		PaddingRight = UDim.new(0, 12),
	}, root)
	create("UIListLayout", {
		SortOrder = Enum.SortOrder.LayoutOrder,
		Padding = UDim.new(0, 8),
	}, root)
	self.root = root

	self.elements.title = label("NOVA", 16, root, 1, true)
	self.elements.subtitle = label("Studio development bridge", 11, root, 2)

	local statusRow = create("Frame", {
		BackgroundTransparency = 1,
		Size = UDim2.new(1, 0, 0, 18),
		LayoutOrder = 3,
	}, root)
	self.elements.dot = create("Frame", {
		Size = UDim2.fromOffset(8, 8),
		Position = UDim2.fromOffset(0, 5),
		BorderSizePixel = 0,
	}, statusRow)
	create("UICorner", { CornerRadius = UDim.new(1, 0) }, self.elements.dot)
	self.elements.status = create("TextLabel", {
		Text = "Disconnected",
		Font = Enum.Font.GothamMedium,
		TextSize = 13,
		TextXAlignment = Enum.TextXAlignment.Left,
		BackgroundTransparency = 1,
		Position = UDim2.fromOffset(16, 0),
		Size = UDim2.new(1, -16, 1, 0),
	}, statusRow)

	self.elements.detail = label("Not connected", 11, root, 4)

	self.elements.portLabel = label("Bridge port", 11, root, 5)
	self.elements.port = create("TextBox", {
		Text = tostring(options.port),
		Font = Enum.Font.Code,
		TextSize = 13,
		ClearTextOnFocus = false,
		Size = UDim2.new(1, 0, 0, 26),
		BorderSizePixel = 1,
		LayoutOrder = 6,
	}, root)

	self.elements.codeLabel = label("Pairing code from Nova", 11, root, 7)
	self.elements.code = create("TextBox", {
		Text = "",
		PlaceholderText = "000000",
		Font = Enum.Font.Code,
		TextSize = 16,
		ClearTextOnFocus = false,
		Size = UDim2.new(1, 0, 0, 30),
		BorderSizePixel = 1,
		LayoutOrder = 8,
	}, root)

	self.elements.action = create("TextButton", {
		Text = "Connect",
		Font = Enum.Font.GothamMedium,
		TextSize = 13,
		Size = UDim2.new(1, 0, 0, 30),
		BorderSizePixel = 0,
		AutoButtonColor = true,
		LayoutOrder = 9,
	}, root)
	create("UICorner", { CornerRadius = UDim.new(0, 4) }, self.elements.action)

	self.elements.footer = label("", 10, root, 10)

	self.elements.port.FocusLost:Connect(function()
		local port = tonumber(self.elements.port.Text)
		if port and port >= 1024 and port <= 49151 and port == math.floor(port) then
			options.onPortChange(port)
		else
			self.elements.port.Text = tostring(options.getPort())
		end
	end)

	self.elements.code.FocusLost:Connect(function(enterPressed: boolean)
		if enterPressed then
			options.onConnect(self.elements.code.Text)
		end
	end)

	self.elements.action.Activated:Connect(function()
		if self.connected then
			options.onDisconnect()
		else
			options.onConnect(self.elements.code.Text)
		end
	end)

	self.themeConnection = settings().Studio.ThemeChanged:Connect(function()
		self:applyTheme()
	end)
	self:applyTheme()

	return self
end

function Ui:applyTheme()
	local text = color(Enum.StudioStyleGuideColor.MainText)
	local dim = color(Enum.StudioStyleGuideColor.DimmedText)
	local field = color(Enum.StudioStyleGuideColor.InputFieldBackground)
	local border = color(Enum.StudioStyleGuideColor.Border)

	self.root.BackgroundColor3 = color(Enum.StudioStyleGuideColor.MainBackground)
	self.elements.title.TextColor3 = text
	self.elements.status.TextColor3 = text
	for _, name in { "subtitle", "detail", "portLabel", "codeLabel", "footer" } do
		self.elements[name].TextColor3 = dim
	end
	for _, name in { "port", "code" } do
		local box = self.elements[name]
		box.BackgroundColor3 = field
		box.TextColor3 = text
		box.BorderColor3 = border
	end
	self.elements.action.BackgroundColor3 = color(Enum.StudioStyleGuideColor.DialogMainButton)
	self.elements.action.TextColor3 = color(Enum.StudioStyleGuideColor.DialogMainButtonText)
end

function Ui:toggle()
	self.widget.Enabled = not self.widget.Enabled
end

--[[
	Renders connection state. The code field only exists while there is pairing
	to do, so a connected panel is quiet.
]]
function Ui:render(connection)
	local connected = connection.state == "connected"
	local connecting = connection.state == "connecting"
	self.connected = connected

	self.elements.status.Text = if connected then "Connected" elseif connecting then "Connecting…" else "Disconnected"
	self.elements.dot.BackgroundColor3 = if connected
		then Color3.fromRGB(92, 184, 92)
		elseif connecting then Color3.fromRGB(220, 170, 60)
		else color(Enum.StudioStyleGuideColor.DimmedText)
	self.elements.detail.Text = connection.detail

	self.elements.codeLabel.Visible = not connected
	self.elements.code.Visible = not connected
	self.elements.portLabel.Visible = not connected
	self.elements.port.Visible = not connected
	self.elements.action.Text = if connected then "Disconnect" elseif connecting then "Connecting…" else "Connect"
	self.elements.action.Active = not connecting

	local footer = "Protocol " .. connection.protocolVersion
	if connected and connection.sessionId then
		footer = footer .. " · session " .. string.sub(connection.sessionId, 1, 8)
	end
	self.elements.footer.Text = footer

	if not connected then
		self.elements.code.Text = ""
	end
end

function Ui:destroy()
	if self.themeConnection then
		self.themeConnection:Disconnect()
		self.themeConnection = nil
	end
	if self.widget then
		self.widget:Destroy()
		self.widget = nil
	end
end

return Ui
