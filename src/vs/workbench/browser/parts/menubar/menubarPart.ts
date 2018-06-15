/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'vs/workbench/browser/parts/menubar/menubar.contribution';
import 'vs/css!./media/menubarpart';
import * as nls from 'vs/nls';
import * as browser from 'vs/base/browser/browser';
import { Part } from 'vs/workbench/browser/part';
import { IMenubarService, IMenubarMenu, IMenubarMenuItemAction, IMenubarData } from 'vs/platform/menubar/common/menubar';
import { IMenuService, MenuId, IMenu } from 'vs/platform/actions/common/actions';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { IWindowService, MenuBarVisibility } from 'vs/platform/windows/common/windows';
import { IContextKeyService, ContextKeyExpr } from 'vs/platform/contextkey/common/contextkey';
import { ActionRunner, IActionRunner, IAction } from 'vs/base/common/actions';
import { Builder, $ } from 'vs/base/browser/builder';
import { Separator, ActionItem } from 'vs/base/browser/ui/actionbar/actionbar';
import { EventType, Dimension } from 'vs/base/browser/dom';
import { TITLE_BAR_ACTIVE_BACKGROUND, TITLE_BAR_ACTIVE_FOREGROUND } from 'vs/workbench/common/theme';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { isWindows, isMacintosh } from 'vs/base/common/platform';
import { Menu, IMenuOptions } from 'vs/base/browser/ui/menu/menu';
import { KeyCode, KeyCodeUtils, KeyMod } from 'vs/base/common/keyCodes';
import { StandardKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { KeybindingsRegistry } from 'vs/platform/keybinding/common/keybindingsRegistry';
import URI from 'vs/base/common/uri';
import { IConfigurationService, IConfigurationChangeEvent } from 'vs/platform/configuration/common/configuration';
import { Color } from 'vs/base/common/color';
import { Event, Emitter } from 'vs/base/common/event';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { domEvent } from 'vs/base/browser/event';

interface CustomMenu {
	title: string;
	titleElement: Builder;
	actions?: IAction[];
}

export class MenubarPart extends Part {

	private keys = [
		'files.autoSave',
		'window.menuBarVisibility',
		'editor.multiCursorModifier',
		'workbench.sideBar.location',
		'workbench.statusBar.visible',
		'workbench.activityBar.visible',
		'window.enableMenuBarMnemonics',
		// 'window.nativeTabs'
	];

	private topLevelMenus: {
		'File': IMenu;
		'Edit': IMenu;
		'Recent': IMenu;
		'Selection': IMenu;
		'View': IMenu;
		'Layout': IMenu;
		'Go': IMenu;
		'Debug': IMenu;
		'Tasks': IMenu;
		'Window'?: IMenu;
		'Preferences': IMenu;
		'Help': IMenu;
		[index: string]: IMenu;
	};

	private topLevelTitles = {
		'File': nls.localize({ key: 'mFile', comment: ['&& denotes a mnemonic'] }, "&&File"),
		'Edit': nls.localize({ key: 'mEdit', comment: ['&& denotes a mnemonic'] }, "&&Edit"),
		'Recent': nls.localize({ key: 'mRecent', comment: ['&& denotes a mnemonic'] }, "&&Recent"),
		'Selection': nls.localize({ key: 'mSelection', comment: ['&& denotes a mnemonic'] }, "&&Selection"),
		'View': nls.localize({ key: 'mView', comment: ['&& denotes a mnemonic'] }, "&&View"),
		'Layout': nls.localize({ key: 'mLayout', comment: ['&& denotes a mnemonic'] }, "&&Layout"),
		'Go': nls.localize({ key: 'mGoto', comment: ['&& denotes a mnemonic'] }, "&&Go"),
		'Debug': nls.localize({ key: 'mDebug', comment: ['&& denotes a mnemonic'] }, "&&Debug"),
		'Tasks': nls.localize({ key: 'mTasks', comment: ['&& denotes a mnemonic'] }, "&&Tasks"),
		'Preferences': nls.localize({ key: 'mPreferences', comment: ['&& denotes a mnemonic'] }, "&&Preferences"),
		'Help': nls.localize({ key: 'mHelp', comment: ['&& denotes a mnemonic'] }, "&&Help")
	};

	private mnemonics: {
		[index: number]: number;
	} = {};

	private focusedMenu: {
		index: number;
		holder: Builder;
		widget: Menu;
	};

	private customMenus: CustomMenu[];

	private actionRunner: IActionRunner;
	private container: Builder;
	private _isFocused: boolean;
	private _onVisibilityChange: Emitter<Dimension>;

	constructor(
		id: string,
		@IThemeService themeService: IThemeService,
		@IMenubarService private menubarService: IMenubarService,
		@IMenuService private menuService: IMenuService,
		@IWindowService private windowService: IWindowService,
		@IContextKeyService private contextKeyService: IContextKeyService,
		@IKeybindingService private keybindingService: IKeybindingService,
		@IConfigurationService private configurationService: IConfigurationService
	) {
		super(id, { hasTitle: false }, themeService);

		this.topLevelMenus = {
			'File': this.menuService.createMenu(MenuId.MenubarFileMenu, this.contextKeyService),
			'Edit': this.menuService.createMenu(MenuId.MenubarEditMenu, this.contextKeyService),
			'Recent': this.menuService.createMenu(MenuId.MenubarRecentMenu, this.contextKeyService),
			'Selection': this.menuService.createMenu(MenuId.MenubarSelectionMenu, this.contextKeyService),
			'View': this.menuService.createMenu(MenuId.MenubarViewMenu, this.contextKeyService),
			'Layout': this.menuService.createMenu(MenuId.MenubarLayoutMenu, this.contextKeyService),
			'Go': this.menuService.createMenu(MenuId.MenubarGoMenu, this.contextKeyService),
			'Debug': this.menuService.createMenu(MenuId.MenubarDebugMenu, this.contextKeyService),
			'Tasks': this.menuService.createMenu(MenuId.MenubarTasksMenu, this.contextKeyService),
			'Preferences': this.menuService.createMenu(MenuId.MenubarPreferencesMenu, this.contextKeyService),
			'Help': this.menuService.createMenu(MenuId.MenubarHelpMenu, this.contextKeyService)
		};

		if (isMacintosh) {
			this.topLevelMenus['Window'] = this.menuService.createMenu(MenuId.MenubarWindowMenu, this.contextKeyService);
		}

		this.actionRunner = new ActionRunner();
		this.actionRunner.onDidBeforeRun(() => {
			if (this.focusedMenu && this.focusedMenu.holder) {
				this.focusedMenu.holder.hide();
			}
		});

		for (let topLevelMenuName of Object.keys(this.topLevelMenus)) {
			this.topLevelMenus[topLevelMenuName].onDidChange(() => this.setupNativeMenubar());
		}

		this._onVisibilityChange = new Emitter<Dimension>();

		this.setupNativeMenubar();

		this.isFocused = false;

		this.registerListeners();
	}

	private get currentEnableMenuBarMnemonics(): boolean {
		let enableMenuBarMnemonics = this.configurationService.getValue<boolean>('window.enableMenuBarMnemonics');
		if (typeof enableMenuBarMnemonics !== 'boolean') {
			enableMenuBarMnemonics = true;
		}

		return enableMenuBarMnemonics;
	}

	private get currentMultiCursorSetting(): string {
		return this.configurationService.getValue<string>('editor.multiCursorModifier');
	}

	private get currentAutoSaveSetting(): string {
		return this.configurationService.getValue<string>('files.autoSave');
	}

	private get currentSidebarPosition(): string {
		return this.configurationService.getValue<string>('workbench.sideBar.location');
	}

	private get currentStatusBarVisibility(): boolean {
		let setting = this.configurationService.getValue<boolean>('workbench.statusBar.visible');
		if (typeof setting !== 'boolean') {
			setting = true;
		}

		return setting;
	}

	private get currentActivityBarVisibility(): boolean {
		let setting = this.configurationService.getValue<boolean>('workbench.activityBar.visible');
		if (typeof setting !== 'boolean') {
			setting = true;
		}

		return setting;
	}

	private get currentMenubarVisibility(): MenuBarVisibility {
		return this.configurationService.getValue<MenuBarVisibility>('window.menuBarVisibility');
	}

	private get currentTitlebarStyleSetting(): string {
		return this.configurationService.getValue<string>('window.titleBarStyle');
	}

	private get isFocused(): boolean {
		return this._isFocused;
	}

	private set isFocused(value: boolean) {
		this._isFocused = value;

		if (!this._isFocused && this.currentMenubarVisibility === 'toggle') {
			if (this.container) {
				this.hideMenubar();
			}
		}
	}

	private onDidChangeFullscreen(): void {
		this.updateStyles();
	}

	private onConfigurationUpdated(event: IConfigurationChangeEvent): void {
		if (this.keys.some(key => event.affectsConfiguration(key))) {
			this.setupMenubar();
		}
	}

	private hideMenubar(): void {
		this._onVisibilityChange.fire(new Dimension(0, 0));
		this.container.style('visibility', 'hidden');
	}

	private showMenubar(): void {
		this._onVisibilityChange.fire(this.getMenubarItemsDimensions());
		this.container.style('visibility', null);
	}

	private onAltKeyToggled(altKeyDown: boolean): void {
		if (this.currentMenubarVisibility === 'toggle') {
			if (altKeyDown) {
				this.showMenubar();
			} else if (!this.isFocused) {
				this.hideMenubar();
			}
		}

		if (this.currentEnableMenuBarMnemonics) {
			this.customMenus.forEach(customMenu => {
				let child = customMenu.titleElement.child();
				if (child) {
					let grandChild = child.child();
					if (grandChild) {
						grandChild.style('text-decoration', altKeyDown ? 'underline' : null);
					}
				}
			});
		}
	}

	private registerListeners(): void {
		browser.onDidChangeFullscreen(() => this.onDidChangeFullscreen());

		// Update when config changes
		this.configurationService.onDidChangeConfiguration(e => this.onConfigurationUpdated(e));

		// Listen to update service
		// this.updateService.onStateChange(() => this.setupMenubar());

		// Listen to keybindings change
		this.keybindingService.onDidUpdateKeybindings(() => this.setupMenubar());

		AlternativeKeyEmitter.getInstance().event(this.onAltKeyToggled, this);
	}

	private setupMenubar(): void {
		if (this.currentTitlebarStyleSetting === 'custom') {
			this.setupCustomMenubar();
		} else {
			this.setupNativeMenubar();
		}
	}

	private setupNativeMenubar(): void {
		this.menubarService.updateMenubar(this.windowService.getCurrentWindowId(), this.getMenubarMenus());
	}

	private registerMnemonic(menuIndex: number, keyCode: KeyCode): void {
		KeybindingsRegistry.registerCommandAndKeybindingRule({
			id: 'menubar.mnemonics.' + menuIndex,
			weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
			when: ContextKeyExpr.has('config.window.enableMenuBarMnemonics'),
			primary: null,
			win: { primary: KeyMod.Alt | keyCode },
			handler: (accessor, resource: URI | object) => {
				if (!this.focusedMenu) {
					this.isFocused = true;
					this.toggleCustomMenu(menuIndex);
				}
			}
		});
	}

	private setCheckedStatus(action: IAction | IMenubarMenuItemAction) {
		switch (action.id) {
			case 'workbench.action.toggleAutoSave':
				action.checked = this.currentAutoSaveSetting !== 'off';
				break;

			default:
				break;
		}
	}

	private calculateActionLabel(action: IAction | IMenubarMenuItemAction): string {
		let label = action.label;
		switch (action.id) {
			case 'workbench.action.toggleMultiCursorModifier':
				if (this.currentMultiCursorSetting === 'ctrlCmd') {
					label = nls.localize('miMultiCursorAlt', "Switch to Alt+Click for Multi-Cursor");
				} else {
					label = isMacintosh
						? nls.localize('miMultiCursorCmd', "Switch to Cmd+Click for Multi-Cursor")
						: nls.localize('miMultiCursorCtrl', "Switch to Ctrl+Click for Multi-Cursor");
				}
				break;

			case 'workbench.action.toggleSidebarPosition':
				if (this.currentSidebarPosition !== 'right') {
					label = nls.localize({ key: 'miMoveSidebarRight', comment: ['&& denotes a mnemonic'] }, "&&Move Side Bar Right");
				} else {
					label = nls.localize({ key: 'miMoveSidebarLeft', comment: ['&& denotes a mnemonic'] }, "&&Move Side Bar Left");
				}
				break;

			case 'workbench.action.toggleStatusbarVisibility':
				if (this.currentStatusBarVisibility) {
					label = nls.localize({ key: 'miHideStatusbar', comment: ['&& denotes a mnemonic'] }, "&&Hide Status Bar");
				} else {
					label = nls.localize({ key: 'miShowStatusbar', comment: ['&& denotes a mnemonic'] }, "&&Show Status Bar");
				}
				break;

			case 'workbench.action.toggleActivityBarVisibility':
				if (this.currentActivityBarVisibility) {
					label = nls.localize({ key: 'miHideActivityBar', comment: ['&& denotes a mnemonic'] }, "Hide &&Activity Bar");
				} else {
					label = nls.localize({ key: 'miShowActivityBar', comment: ['&& denotes a mnemonic'] }, "Show &&Activity Bar");
				}
				break;

			default:
				break;
		}

		return this.currentEnableMenuBarMnemonics ? label : label.replace(/&&(.)/g, '$1');
	}

	private setupCustomMenubar(): void {
		this.container.empty();
		this.container.attr('role', 'menubar');

		this.customMenus = [];

		let idx = 0;

		for (let menuTitle of Object.keys(this.topLevelMenus)) {
			const menu: IMenu = this.topLevelMenus[menuTitle];
			let menuIndex = idx++;

			let titleElement = $(this.container).div({ class: 'menubar-menu-button' });
			let displayTitle = this.topLevelTitles[menuTitle].replace(/&&(.)/g, this.currentEnableMenuBarMnemonics ? '<mnemonic>$1</mnemonic>' : '$1');
			let legibleTitle = this.topLevelTitles[menuTitle].replace(/&&(.)/g, '$1');
			$(titleElement).div({ class: 'menubar-menu-title', 'aria-hidden': true }).innerHtml(displayTitle);

			titleElement.attr('aria-label', legibleTitle);
			titleElement.attr('role', 'menu');

			let mnemonic = (/&&(.)/g).exec(this.topLevelTitles[menuTitle])[1];
			if (mnemonic) {
				this.registerMnemonic(menuIndex, KeyCodeUtils.fromString(mnemonic));
			}

			this.customMenus.push({
				title: menuTitle,
				titleElement: titleElement
			});

			// Update cached actions array for CustomMenus
			const updateActions = () => {
				this.customMenus[menuIndex].actions = [];
				let groups = menu.getActions();
				for (let group of groups) {
					const [, actions] = group;

					actions.map((action: IAction) => {
						action.label = this.calculateActionLabel(action);
						this.setCheckedStatus(action);
					});

					this.customMenus[menuIndex].actions.push(...actions);
					this.customMenus[menuIndex].actions.push(new Separator());
				}

				this.customMenus[menuIndex].actions.pop();
			};

			menu.onDidChange(updateActions);
			updateActions();

			this.customMenus[menuIndex].titleElement.on(EventType.CLICK, (event) => {
				this.toggleCustomMenu(menuIndex);
				this.isFocused = !this.isFocused;
			});

			this.customMenus[menuIndex].titleElement.getHTMLElement().onmouseenter = () => {
				if (this.isFocused && !this.isCurrentMenu(menuIndex)) {
					this.toggleCustomMenu(menuIndex);
				}
			};

			this.customMenus[menuIndex].titleElement.getHTMLElement().onmouseleave = () => {
				if (!this.isFocused) {
					this.cleanupCustomMenu();
				}
			};

			this.customMenus[menuIndex].titleElement.getHTMLElement().onblur = () => {
				this.cleanupCustomMenu();
			};
		}

		$(this.container).on(EventType.KEY_DOWN, (e) => {
			let event = new StandardKeyboardEvent(e as KeyboardEvent);
			let eventHandled = true;

			if (event.equals(KeyCode.LeftArrow)) {
				this.focusPrevious();
			} else if (event.equals(KeyCode.RightArrow)) {
				this.focusNext();
			} else if (event.altKey && event.keyCode && this.mnemonics[event.keyCode] !== undefined && !this.focusedMenu) {
				this.toggleCustomMenu(this.mnemonics[event.keyCode]);
			} else {
				eventHandled = false;
			}

			if (eventHandled) {
				event.preventDefault();
				event.stopPropagation();
			}
		});
	}

	private focusPrevious(): void {
		if (!this.focusedMenu) {
			return;
		}

		let newFocusedIndex = (this.focusedMenu.index - 1 + this.customMenus.length) % this.customMenus.length;

		if (newFocusedIndex === this.focusedMenu.index) {
			return;
		}

		this.toggleCustomMenu(newFocusedIndex);
	}

	private focusNext(): void {
		if (!this.focusedMenu) {
			return;
		}

		let newFocusedIndex = (this.focusedMenu.index + 1) % this.customMenus.length;

		if (newFocusedIndex === this.focusedMenu.index) {
			return;
		}

		this.toggleCustomMenu(newFocusedIndex);
	}

	private getMenubarMenus(): IMenubarData {
		let ret: IMenubarData = {};

		for (let topLevelMenuName of Object.keys(this.topLevelMenus)) {
			const menu = this.topLevelMenus[topLevelMenuName];
			let menubarMenu: IMenubarMenu = { items: [] };
			let groups = menu.getActions();
			for (let group of groups) {
				const [, actions] = group;

				actions.forEach(menuItemAction => {
					let menubarMenuItem: IMenubarMenuItemAction = {
						id: menuItemAction.id,
						label: menuItemAction.label,
						checked: menuItemAction.checked,
						enabled: menuItemAction.enabled
					};

					this.setCheckedStatus(menubarMenuItem);
					menubarMenuItem.label = this.calculateActionLabel(menubarMenuItem);

					menubarMenu.items.push(menubarMenuItem);
				});

				menubarMenu.items.push({ id: 'vscode.menubar.separator' });
			}

			if (menubarMenu.items.length > 0) {
				menubarMenu.items.pop();
			}

			ret[topLevelMenuName] = menubarMenu;
		}

		return ret;
	}

	private isCurrentMenu(menuIndex: number): boolean {
		if (!this.focusedMenu) {
			return false;
		}

		return this.focusedMenu.index === menuIndex;
	}

	private cleanupCustomMenu(): void {
		if (this.focusedMenu) {

			if (this.focusedMenu.holder) {
				$(this.focusedMenu.holder.getHTMLElement().parentElement).removeClass('open');
				this.focusedMenu.holder.dispose();
			}

			if (this.focusedMenu.widget) {
				this.focusedMenu.widget.dispose();
			}
		}

		this.focusedMenu = null;
	}

	public focusCustomMenu(menuTitle: string): void {
		this.toggleCustomMenu(0);
	}

	private _getActionItem(action: IAction): ActionItem {
		const keybinding = this.keybindingService.lookupKeybinding(action.id);
		if (keybinding) {
			return new ActionItem(action, action, { label: true, keybinding: keybinding.getLabel(), isMenu: true });
		}
		return null;
	}

	private toggleCustomMenu(menuIndex: number): void {
		const customMenu = this.customMenus[menuIndex];

		if (this.focusedMenu) {
			let hiding: boolean = this.isCurrentMenu(menuIndex);

			// Need to cleanup currently displayed menu
			this.cleanupCustomMenu();

			// Hiding this menu
			if (hiding) {
				return;
			}
		}

		customMenu.titleElement.domFocus();

		let menuHolder = $(customMenu.titleElement).div({ class: 'menubar-menu-items-holder' });

		$(menuHolder.getHTMLElement().parentElement).addClass('open');

		menuHolder.addClass('menubar-menu-items-holder-open context-view');
		menuHolder.style({
			'top': `${this.container.getClientArea().height}px`
		});

		let menuOptions: IMenuOptions = {
			actionRunner: this.actionRunner,
			ariaLabel: 'File',
			actionItemProvider: (action) => { return this._getActionItem(action); }
		};

		let menuWidget = new Menu(menuHolder.getHTMLElement(), customMenu.actions, menuOptions);

		menuWidget.onDidCancel(() => {
			this.cleanupCustomMenu();
			this.isFocused = false;
		});

		menuWidget.onDidBlur(() => {
			setTimeout(() => {
				this.cleanupCustomMenu();
				this.isFocused = false;
			}, 100);
		});

		menuWidget.focus();

		this.focusedMenu = {
			index: menuIndex,
			holder: menuHolder,
			widget: menuWidget
		};
	}

	updateStyles(): void {
		super.updateStyles();

		// Part container
		if (this.container) {
			const fgColor = this.getColor(TITLE_BAR_ACTIVE_FOREGROUND);
			const bgColor = this.getColor(TITLE_BAR_ACTIVE_BACKGROUND);

			this.container.style('color', fgColor);
			if (browser.isFullscreen()) {
				this.container.style('background-color', bgColor);
			} else {
				this.container.style('background-color', null);
			}

			this.container.getHTMLElement().classList.toggle('light', Color.fromHex(bgColor).isLighter());
		}
	}

	public get onVisibilityChange(): Event<Dimension> {
		return this._onVisibilityChange.event;
	}

	public layout(dimension: Dimension): Dimension[] {
		// this.container.style({
		// 	'transform': `scale(${1 / browser.getZoomFactor()}, ${1 /browser.getZoomFactor()})`
		// });

		if (this.currentMenubarVisibility === 'toggle') {
			this.hideMenubar();
		} else {
			this.showMenubar();
		}

		return super.layout(dimension);
	}

	public getMenubarItemsDimensions(): Dimension {
		if (this.customMenus) {
			const left = this.customMenus[0].titleElement.getHTMLElement().getBoundingClientRect().left;
			const right = this.customMenus[this.customMenus.length - 1].titleElement.getHTMLElement().getBoundingClientRect().right;
			return new Dimension(right - left, this.container.getClientArea().height);
		}

		return new Dimension(0, 0);
	}

	public createContentArea(parent: HTMLElement): HTMLElement {
		this.container = $(parent);

		if (!isWindows) {
			return this.container.getHTMLElement();
		}

		// Build the menubar
		if (this.container) {
			this.setupCustomMenubar();
		}

		return this.container.getHTMLElement();
	}
}

class AlternativeKeyEmitter extends Emitter<boolean> {

	private _subscriptions: IDisposable[] = [];
	private _isPressed: boolean;
	private static instance: AlternativeKeyEmitter;
	private _suppressAltKeyUp: boolean = false;

	private constructor() {
		super();

		this._subscriptions.push(domEvent(document.body, 'keydown')(e => {
			if (e.altKey) {
				this.isPressed = true;
			}
		}));
		this._subscriptions.push(domEvent(document.body, 'keyup')(e => {
			if (this.isPressed && !e.altKey) {
				if (this._suppressAltKeyUp) {
					e.preventDefault();
				}

				this._suppressAltKeyUp = false;
				this.isPressed = false;
			}
		}));
		this._subscriptions.push(domEvent(document.body, 'mouseleave')(e => {
			if (this.isPressed) {
				this.isPressed = false;
			}
		}));

		this._subscriptions.push(domEvent(document.body, 'blur')(e => {
			if (this.isPressed) {
				this.isPressed = false;
			}
		}));
	}

	get isPressed(): boolean {
		return this._isPressed;
	}

	set isPressed(value: boolean) {
		this._isPressed = value;
		this.fire(this._isPressed);
	}

	suppressAltKeyUp() {
		// Sometimes the native alt behavior needs to be suppresed since the alt was already used as an alternative key
		// Example: windows behavior to toggle tha top level menu #44396
		this._suppressAltKeyUp = true;
	}

	static getInstance() {
		if (!AlternativeKeyEmitter.instance) {
			AlternativeKeyEmitter.instance = new AlternativeKeyEmitter();
		}

		return AlternativeKeyEmitter.instance;
	}

	dispose() {
		super.dispose();
		this._subscriptions = dispose(this._subscriptions);
	}
}