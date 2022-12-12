"use strict";

// Actor is the base class for the actor tree.  Actors can have parent and child actors.
// Shutting down an actor will shut down its children.  Each actor has an AbortSignal
// which is aborted when the actor shuts down, so event listeners, fetches, etc. can be
// shut down with the actor.
//
// Most actors are widgets and should derive from ppixiv.widget.  The base actor class
// doesn't have HTML content or add itself to the DOM tree.  Non-widget actors are used
// for helpers that want to live in the actor tree, but don't have content of their own.
ppixiv.actor = class extends EventTarget
{
    // If true, stack traces will be logged if shutdown() is called more than once.  This takes
    // a stack trace on each shutdown, so it's only enabled when needed.
    static debug_shutdown = true;

    // A list of top-level actors (actors with no parent).  This is just for debugging.
    static top_actors = [];

    // Dump the actor tree to the console.
    static dump_actors({parent=null}={})
    {
        let actors = parent? parent.child_actors:ppixiv.actor.top_actors;

        let grouped = false;
        if(parent)
        {
            // If this parent has any children, create a logging group.  Otherwise, just log it normally.
            if(actors.length == 0)
                console.log(parent);
            else
            {
                console.group(parent);
                grouped = true;
            }
        }

        try {
            for(let actor of actors)
                ppixiv.actor.dump_actors({parent: actor});
        } finally {
            // Only remove the logging group if we created one.
            if(grouped)
                console.groupEnd();
        }
    }

    constructor({
        container,
        
        // The parent actor, if any.
        parent=null,

        // The actor will be shut down if this is aborted.
        signal=null,
        ...options
    }={})
    {
        super();
        
        this.options = options;

        this.templates = {};
        this.child_actors = [];

        this.parent = parent;

        // Create our shutdown_signal.  We'll abort this if we're shut down to shut down our children.
        // This is always shut down by us when shutdown() is called (it isn't used to shut us down).
        this.shutdown_signal = new AbortController();

        // If we weren't given a shutdown signal explicitly and we have a parent actor, inherit
        // its signal, so we'll shut down when the parent does.
        if(signal == null && this.parent != null)
            signal = this.parent.shutdown_signal.signal;

        // If we were given a parent shutdown signal, shut down if it aborts.
        if(signal)
            signal.addEventListener("abort", () => this.shutdown(), { once: true, ...this._signal });

        // Register ourself in our parent's child list.
        if(this.parent)
            this.parent._child_added(this);
        else
            ppixiv.actor.top_actors.push(this);
    }

    shutdown()
    {
        if(ppixiv.actor.debug_shutdown && !this._previous_shutdown_stack)
        {
            try {
                throw new Error();
            } catch(e) {
                this._previous_shutdown_stack = e.stack;
            }
        }

        // We should only be shut down once, so shutdown_signal shouldn't already be signalled.
        if(this.shutdown_signal.signal.aborted)
        {
            console.error("Actor has already shut down:", this);
            if(this._previous_shutdown_stack)
                console.log("Previous shutdown stack:", this._previous_shutdown_stack);
            return;
        }

        // This will shut down everything associated with this actor, as well as any child actors.
        this.shutdown_signal.abort();

        // All of our children should have shut down and removed themselves from our child list.
        if(this.child_actors.length != 0)
        {
            for(let child of this.child_actors)
                console.warn("Child of", this, "didn't shut down:", child);
        }

        // If we have a parent, remove ourself from it.  Otherwise, remove ourself from
        // top_actors.
        if(this.parent)
            this.parent._child_removed(this);
        else
        {
            let idx = ppixiv.actor.top_actors.indexOf(this);
            console.assert(idx != -1);
            ppixiv.actor.top_actors.splice(idx, 1);
        }
    }

    // Create an element from template HTML.  If name isn't null, the HTML will be cached
    // using name as a key.
    create_template({name=null, html, make_svg_unique=true})
    {
        let template = name? this.templates[name]:null;
        if(!template)
        {
            template = document.createElement("template");
            template.innerHTML = html;
            helpers.replace_inlines(template.content);
            
            this.templates[name] = template;
        }

        return helpers.create_from_template(template, { make_svg_unique });
    }

    // For convenience, return options to add to an event listener and other objects that
    // take an AbortSignal to shut down when the rest of the actor does.
    //
    // node.addEventListener("event", func, this._signal);
    // node.addEventListener("event", func, { capture: true, ...this._signal });
    get _signal()
    {
        return { signal: this.shutdown_signal.signal };
    }

    _child_added(child)
    {
        this.child_actors.push(child);
    }

    _child_removed(child)
    {
        let idx = this.child_actors.indexOf(child);
        if(idx == -1)
        {
            console.warn("Actor wasn't in the child list:", child);
            return;
        }

        this.child_actors.splice(idx, 1);
    }

    // Yield all parents of this node.  If include_self is true, yield ourself too.
    *ancestors({include_self=false}={})
    {
        if(include_self)
            yield this;

        let count = 0;
        let parent = this.parent;
        while(parent != null)
        {
            yield parent;
            parent = parent.parent;

            count++;
            if(count > 10000)
                throw new Error("Recursion detected");
        }
    }

    // Yield all descendants of this node, depth-first.  If include_self is true, yield ourself too.
    *descendents({include_self=false}={})
    {
        if(include_self)
            yield this;

        for(let child of this.child_actors)
        {
            yield child;
            for(let child_descendants of child.descendents())
                yield child_descendants;
        }
    }

    // Non-widget actors are always visible.
    get visible() { return true; }

    // Return true if we and all of our ancestors are visible.
    //
    // This is based on this.visible.  For widgets that animate on and off, this becomes false
    // as soon as the widget begins hiding (this.visible becomes false), without waiting for the
    // animation to finish (this.actually_visible).  This allows child widgets to animate away
    // along with the parent.
    get visible_recursively()
    {
        for(let node of this.ancestors({include_self: true}))
        {
            if(!node.visible)
                return false;
        }

        return true;
    }

    // Call on_visible_recursively_changed on the hierarchy.
    _call_on_visible_recursively_changed()
    {
        for(let actor of this.descendents({include_self: true}))
        {
            if(actor.on_visible_recursively_changed)
                actor.on_visible_recursively_changed(this);
        }
    }

    // This is called when visible_recursively may have changed.
    on_visible_recursively_changed() { }
}

// A basic widget base class.
ppixiv.widget = class extends ppixiv.actor
{
    // Find the widget containing a node.
    static from_node(node, { allow_none=false }={})
    {
        // The top node for the widget has the widget class.
        let widget_top_node = node.closest(".widget");
        if(widget_top_node == null)
        {
            if(allow_none)
                return null;

            console.log("Node wasn't in a widget:", node);
            throw new Error("Node wasn't in a widget:", node);
        }

        console.assert(widget_top_node.widget != null);
        return widget_top_node.widget;
    }

    constructor({
        container,
        template=null,
        contents=null,
        visible=true,
        parent=null,

        // An insertAdjacentElement position (beforebegin, afterbegin, beforeend, afterend) indicating
        // where our contents should be inserted relative to container.  This can also be "replace", which
        // will replace container.
        container_position="beforeend",
        ...options}={})
    {
        // If container is a widget instead of a node, use the container's root node.
        if(container != null && container instanceof ppixiv.widget)
            container = container.container;

        if(parent == null)
        {
            let parent_search_node = container;
            if(contents)
                parent_search_node = contents.parentNode;
            if(parent_search_node == null && parent == null)
                console.warn("Can't search for parent");
            if(parent_search_node)
            {
                let parent_widget = widget.from_node(parent_search_node, { allow_none: true });
                if(parent != null && parent !== parent_widget)
                {
                    console.assert(parent === parent_widget);
                    console.log("Found:", parent_widget);
                    console.log("Expected:", parent);
                }
                parent = parent_widget;
            }
        }

        super({container, parent, ...options});

        // We must have either a template or contents.
        if(template)
        {
            console.assert(contents == null);
            this.container = this.create_template({html: template});
            if(container != null)
            {
                if(container_position == "replace")
                    container.replaceWith(this.container);
                else
                    container.insertAdjacentElement(container_position, this.container);
            }
        }
        else
        {
            // contents is a widget that's already created.  The container is always
            // the parent of contents, so container shouldn't be specified in this mode.
            console.assert(container == null);
            console.assert(contents != null);
            this.container = contents;
        }

        this.container.classList.add("widget");
        this.container.widget = this;

        // visible is the initial visibility.  We can't just set this.visible here, since
        // it'll call refresh and visibility_changed, and the subclass isn't ready for those
        // to be called since it hasn't initialized yet.  Set this._visible directly, and
        // defer the initial refresh.
        this._visible = visible;
        this.apply_visibility();

        helpers.yield(() => {
            this.visibility_changed();
            this.refresh();
        });
    }

    async refresh()
    {
    }

    get visible()
    {
        return this._visible;
    }

    set visible(value)
    {
        if(value == this.visible)
            return;

        this._visible = value;
        this.apply_visibility();

        this.visibility_changed();

        // Let descendants know that visible_recursively may have changed.
        this._call_on_visible_recursively_changed();
    }

    shutdown()
    {
        super.shutdown();

        this.container.remove();
    }

    // Show or hide the widget.
    //
    // By default the widget is visible based on the value of this.visible, but the
    // subclass can override this.
    apply_visibility()
    {
        helpers.set_class(this.container, "hidden-widget", !this._visible);
    }

    // this.visible sets whether or not we want to be visible, but other things might influence
    // it too, like animations.  Setting visible = false on an animated widget will start its
    // hide animation, but actually_visible will return true until the animation finishes.
    get actually_visible()
    {
        return this.visible;
    }

    // This is called when actually_visible changes.  The subclass can override this.
    visibility_changed()
    {
        if(this.actually_visible)
        {
            // Create an AbortController that will be aborted when the widget is hidden.
            if(this.visibility_abort == null)
                this.visibility_abort = new AbortController;
        } else {
            if(this.visibility_abort)
                this.visibility_abort.abort();

            this.visibility_abort = null;
        }
    }

    querySelector(selector) { return this.container.querySelector(selector); }
    querySelectorAll(selector) { return this.container.querySelectorAll(selector); }
    closest(selector) { return this.container.closest(selector); }
}

ppixiv.dialog_widget = class extends ppixiv.widget
{
    // The stack of dialogs currently open:
    static active_dialogs = [];

    static get top_dialog()
    {
        return this.active_dialogs[this.active_dialogs.length-1];
    }

    static _update_block_touch_scrolling()
    {
        if(!ppixiv.ios)
            return;

        // This is really annoying.  No matter how much you shout at iOS to not scroll the document,
        // whether with overflow: hidden, inert or pointer-events: none, it ignores you and scrolls
        // the document underneath the dialog.  The only way I've found to prevent this is by cancelling
        // touchmove (touchstart doesn't work).
        //
        // Note that even touch-action: none doesn't work.  It seems to interpret it as "don't let touches
        // on this element scroll" instead of "this element shouldn't scroll with touch": touches on child
        // elements will still propagate up and scroll the body, which is useless.
        //
        // This hack partially works, but the body still scrolls when it shouldn't if an area is dragged
        // which is set to overflow: auto or overflow: scroll but doesn't actually scroll.  We can't tell
        // that it isn't scrolling, and iOS seems to blindly propagate any touch on a potentially-scrollable
        // element up to the nearest scrollable one.
        if(ppixiv.dialog_widget.active_dialogs.length == 0)
        {
            if(this._remove_touch_scroller_events != null)
            {
                this._remove_touch_scroller_events.abort();
                this._remove_touch_scroller_events = null;
            }
            return;
        }

        // At least one dialog is open.  Start listening to touchmove if we're not already.
        if(this._remove_touch_scroller_events)
            return;

        this._remove_touch_scroller_events = new AbortController();
        window.addEventListener("touchmove", (e) => {
            // Block this movement if it's not inside the topmost open dialog.
            let top_dialog = ppixiv.dialog_widget.top_dialog;
            let dialog = top_dialog.container.querySelector(".dialog");
            if(!helpers.is_above(dialog, e.target))
                e.preventDefault();
        }, { capture: true, passive: false, signal: this._remove_touch_scroller_events.signal });
    }

    constructor({
        classes=null,
        container=null,
        // "normal" is used for larger dialogs, like settings.
        // "small" is used for smaller popups like text entry.
        dialog_type="normal",

        dialog_class=null,

        // The header text:
        header=null,

        // Most dialogs have a close button and allow the user to navigate away.  To
        // disable this and control visibility directly, set this to false.
        allow_close=true,

        // Most dialogs that can be closed have a close button in the corner.  If this is
        // false we'll hide that button, but you can still exit by clicking the background.
        // This is used for very simple dialogs.
        show_close_button=true,

        // If false, this dialog may be large, like settings, and we'll display it in fullscreen
        // on small screens.  If true, weit's a small dialog like a confirmation prompt, and we'll
        // always show it as a floating dialog.  The default is true if dialog_type == "small",
        // otherwise false.
        small=null,

        // If true, the close button shows a back icon instead of an X.
        back_icon=false,

        // The drag direction to close the dialog if the dialog can be dragged to close.
        drag_direction=null,

        template,
        ...options
    })
    {
        if(small == null)
            small = dialog_type == "small";

        // By default, regular dialogs scroll and drag right, so they don't conflict with vertical
        // scrollers.  Small dialogs currently drag down, since animating a small dialog like a
        // text entry horizontally looks weird.
        if(drag_direction == null)
            drag_direction = small? "down":"right";

        // Most dialogs are added to the body element.
        if(container == null)
            container = document.body;
        
        console.assert(dialog_type == "normal" || dialog_type == "small");

        if(dialog_class == null)
            dialog_class = dialog_type == "normal"? "dialog-normal":"dialog-small";

        let close_icon = back_icon? "arrow_back_ios_new":"close";
        
        super({
            container,
            template: `
                <div class="${dialog_class}">
                    <div class="dialog ${classes ?? ""}">
                        <div class=header>
                            <div class="close-button-container">
                                <div class="close-button icon-button">
                                    ${ helpers.create_icon(close_icon) }
                                </div>
                            </div>

                            <span class=header-text></span>

                            <div class=center-header-helper></div>
                        </div>
                        <div class="scroll vertical-scroller">
                            ${ template }
                        </div>
                    </div>
                </div>
            `,
            ...options,
        });

        // Dialogs are always used once and not reused, so they should never be created invisible.
        if(!this.visible)
            throw new Error("Dialog shouldn't be hidden");

        this.small = small;
        helpers.set_class(this.container, "small", this.small);
        helpers.set_class(this.container, "large", !this.small);

        this.refresh_fullscreen();
        window.addEventListener("resize", this.refresh_fullscreen, { signal: this.shutdown_signal.signal });

        // Create the dragger that will control animations.  Animations are only used on mobile.
        if(ppixiv.mobile)
        {
            // drag_direction is the direction to close.  We're giving it to WidgetDragger,
            // which takes the direction ti open, so reverse it.
            drag_direction = {
                down: "up", up: "down", left: "right", right: "left",
            }[drag_direction];

            this.dialog_dragger = new WidgetDragger({
                name: "close-dialog",
                node: this.container,
                drag_node: this.container,
                visible: false,
                size: 150,
                animated_property: "--dialog-visible",

                // Call create_animation again each time this is queried, so the animation can change to
                // adjust to the screen size if needed.
                animations: () => this.create_animation().animation,
                direction: drag_direction,
                onafterhidden: () => this.visibility_changed(),
                onpointerdown: () => this.drag_to_exit,

                // Ignore vertical drags.
                ondragstart: ({event}) => Math.abs(event.movementX) > Math.abs(event.movementY),

                // Set dragging while dragging the dialog to disable the scroller.
                onanimationstart: () => this.container.classList.add("dragging-dialog"),
                onanimationfinished: () => this.container.classList.remove("dragging-dialog"),
            });
        
            this.dialog_dragger.show();
        }

        // By default, dialogs with vertical or horizontal animations are also draggable.  Only
        // animated dialogs can drag to exit.
        // this.drag_to_exit = this.dialog_dragger != null && this.animation != "fade";
        this.drag_to_exit = true;

        // If we're not the first dialog on the stack, make the previous dialog inert, so it'll ignore inputs.
        let old_top_dialog = ppixiv.dialog_widget.top_dialog;
        if(old_top_dialog)
            old_top_dialog.container.inert = true;

        // Add ourself to the stack.
        ppixiv.dialog_widget.active_dialogs.push(this);

        // Register ourself as an important visible widget, so the slideshow won't move on
        // while we're open.
        ppixiv.OpenWidgets.singleton.set(this, true);

        if(!header && !show_close_button)
            this.container.querySelector(".header").hidden = true;

        this.allow_close = allow_close;
        this.container.querySelector(".close-button").hidden = !allow_close || !show_close_button;
        this.header = header;

        window.addEventListener("keydown", this._onkeypress.bind(this), { signal: this.shutdown_signal.signal });

        if(this.allow_close)
        {
            // Close if the container is clicked, but not if something inside the container is clicked.
            this.container.addEventListener("click", (e) => {
                if(e.target != this.container)
                    return;

                this.visible = false;
            });

            let close_button = this.container.querySelector(".close-button");
            if(close_button)
                close_button.addEventListener("click", (e) => { this.visible = false; });

            // Hide if the top-level screen changes, so we close if the user exits the screen with browser
            // navigation but not if the viewed image is changing from something like the slideshow.  Call
            // shutdown() directly instead of setting visible, since we don't want to trigger animations here.
            window.addEventListener("screenchanged", (e) => {
                this.shutdown();
            }, { signal: this.shutdown_signal.signal });

            if(this._close_on_popstate)
            {
                // Hide on any state change.
                window.addEventListener("pp:popstate", (e) => {
                    this.shutdown();
                }, { signal: this.shutdown_signal.signal });
            }
        }

        ppixiv.dialog_widget._update_block_touch_scrolling();
    }

    // The subclass can override this to disable automatically closing on popstate.
    get _close_on_popstate() { return true; }

    set header(value)
    {
        this.container.querySelector(".header-text").textContent = value ?? "";
    }

    refresh_fullscreen = () =>
    {
        helpers.set_class(this.container, "fullscreen", helpers.is_phone && !this.small);
    }

    visibility_changed()
    {
        super.visibility_changed();

        // Remove the widget when it's hidden.  If we're animating, we'll do this after transitionend.
        if(!this.actually_visible)
            this.shutdown();
    }

    _onkeypress(e)
    {
        let idx = ppixiv.dialog_widget.active_dialogs.indexOf(this);
        if(idx == -1)
        {
            console.error("Widget isn't in active_dialogs during keypress:", this);
            return;
        }

        // Ignore keypresses if we're not the topmost dialog.
        if(idx != ppixiv.dialog_widget.active_dialogs.length-1)
            return;

        if(this.handle_keydown(e))
        {
            e.preventDefault();
            e.stopPropagation();
        }
    }

    // This can be overridden by the implementation.
    handle_keydown(e)
    {
        if(this.allow_close && e.key == "Escape")
        {
            this.visible = false;
            return true;
        }

        return false;
    }

    get actually_visible()
    {
        // If we have an animator, it determines whether we're visible.
        if(this.dialog_dragger)
            return this.dialog_dragger.visible;
        else
            return super.visible;
    }

    async apply_visibility()
    {
        if(this.dialog_dragger == null || this._visible)
        {
            super.apply_visibility();
            return;
        }

        // We're being hidden and we have an animation.  Tell the dragger to run our hide
        // animation.  We'll shut down when it finishes.
        this.dialog_dragger.hide();
    }

    // Calling shutdown() directly will remove the dialog immediately.  To remove it and allow
    // animations to run, set visible to false, and the dialog will shut down when the animation
    // finishes.
    shutdown()
    {
        // Remove ourself from active_dialogs.
        let idx = ppixiv.dialog_widget.active_dialogs.indexOf(this);
        if(idx == -1)
            console.error("Widget isn't in active_dialogs when shutting down:", this);
        else
            ppixiv.dialog_widget.active_dialogs.splice(idx, 1);

        // Tell OpenWidgets that we're no longer open.
        ppixiv.OpenWidgets.singleton.set(this, false);

        ppixiv.dialog_widget._update_block_touch_scrolling();

        // If we were covering another dialog, unset inert on the previous dialog.
        let new_top_dialog = ppixiv.dialog_widget.top_dialog;
        if(new_top_dialog)
            new_top_dialog.container.inert = false;

        super.shutdown();
    }
}

// A widget that shows info for a particular media_id.
//
// A media_id can be set, and we'll refresh when it changes.
ppixiv.illust_widget = class extends ppixiv.widget
{
    constructor(options)
    {
        super(options);

        // Refresh when the image data changes.
        ppixiv.media_cache.addEventListener("mediamodified", (e) => {
            if(e.media_id == this._media_id)
                this.refresh();
        }, { signal: this.shutdown_signal.signal });
    }

    // The data this widget needs.  This can be media_id (nothing but the ID), full or partial.
    //
    // This can change dynamically.  Some widgets need illust_info only when viewing a manga
    // page.
    get needed_data() { return "full"; }

    set_media_id(media_id)
    {
        if(this._media_id == media_id)
            return;

        this._media_id = media_id;

        let [illust_id, page] = helpers.media_id_to_illust_id_and_page(media_id);
        this._page = page;
        this.refresh();
    }
    
    get media_id() { return this._media_id; }

    async refresh()
    {
        // Grab the illust info.
        let media_id = this._media_id;
        let info = { media_id: this._media_id };
        
        // If we have a media ID and we want media info (not just the media ID itself), load
        // the info.
        if(this._media_id != null && this.needed_data != "media_id")
        {
            let full = this.needed_data == "full";

            // See if we have the data the widget wants already.
            info.media_info = ppixiv.media_cache.get_media_info_sync(this._media_id, { full });

            // If we need to load data, clear the widget while we load, so we don't show the old
            // data while we wait for data.  Skip this if we don't need to load, so we don't clear
            // and reset the widget.  This can give the widget an illust ID without data, which is
            // OK.
            if(info.media_info == null)
                await this.refresh_internal(info);

            info.media_info = await ppixiv.media_cache.get_media_info(this._media_id, { full });
        }

        // Stop if the media ID changed while we were async.
        if(this._media_id != media_id)
            return;

        await this.refresh_internal(info);
    }

    async refresh_internal({ media_id, media_info })
    {
        throw "Not implemented";
    }
}

// Display messages in the popup widget.  This is a singleton.
ppixiv.message_widget = class extends widget
{
    static get singleton()
    {
        if(message_widget._singleton == null)
            message_widget._singleton = new message_widget({container: document.body});
        return message_widget._singleton;
    }
    
    constructor(options)
    {
        super({...options, template: `
            <div class=hover-message>
                <div class=message></div>
            </div>`,
        });

        this.timer = null;
    }

    show(message)
    {
        console.assert(message != null);

        this.clear_timer();

        this.container.querySelector(".message").innerHTML = message;

        this.container.classList.add("show");
        this.container.classList.remove("centered");
        this.timer = helpers.setTimeout(() => {
            this.container.classList.remove("show");
        }, 3000);
    }

    clear_timer()
    {
        if(this.timer != null)
        {
            helpers.clearTimeout(this.timer);
            this.timer = null;
        }
    }

    hide()
    {
        this.clear_timer();
        this.container.classList.remove("show");
    }
}

// Call a callback on any click not inside a list of nodes.
//
// This is used to close dropdown menus.
ppixiv.click_outside_listener = class extends ppixiv.actor
{
    constructor(node_list, callback)
    {
        super({});

        this.node_list = node_list;
        this.callback = callback;

        new pointer_listener({
            element: document.documentElement,
            button_mask: 0xFFFF,
            callback: this.window_onpointerdown,
            ...this._signal,
        });
    }

    // Return true if node is below any node in node_list.
    _is_node_in_list(node)
    {
        for(let ancestor of this.node_list)
        {
            if(helpers.is_above(ancestor, node))
                return true;
        }
        return false;
    }

    window_onpointerdown = (e) =>
    {
        if(!e.pressed)
            return;
        
        // Close the popup if anything outside the dropdown is clicked.  Don't
        // prevent the click event, so the click still happens.
        //
        // If this is a click inside the box or our button, ignore it.
        if(this._is_node_in_list(e.target))
            return;

        // We don't cancel this event, but set a property on it to let IsolatedTapHandler
        // know this press shouldn't be treated as an isolated tap.
        e.partially_handled = true;

        this.callback(e.target, {event: e});
    }
}

// A helper to display a dropdown aligned to another node.
ppixiv.dropdown_box_opener = class extends ppixiv.actor
{
    constructor({
        button,

        // The dropdown will be closed on clicks outside of the dropdown unless this returns
        // false.
        close_for_click=(e) => true,

        // This is called when button is clicked and should return a widget to display.  The
        // widget will be shut down when it's dismissed.
        create_box=null,

        onvisibilitychanged=() => { },

        ...options
    })
    {
        // Find a parent widget above the button.
        let parent = ppixiv.widget.from_node(button);

        super({
            parent,
            ...options,
        });

        this.button = button;
        this.close_for_click = close_for_click;
        this.onvisibilitychanged = onvisibilitychanged;
        this.create_box = create_box;

        this.box = null;

        this._visible = true;
        this.visible = false;

        // Refresh the position if the box width changes.  Don't refresh on any ResizeObserver
        // call, since that'll recurse and end up refreshing constantly.
        this._box_width = 0;
    }

    onwindowresize = (e) =>
    {
        this._align_to_button();
    };

    // Hide if our tree becomes hidden.
    on_visible_recursively_changed()
    {
        super.on_visible_recursively_changed();

        if(!this.visible_recursively)
            this.visible = false;
    }

    get visible()
    {
        return this._visible;
    }

    set visible(value)
    {
        if(this._visible == value)
            return;

        this._visible = value;

        if(value)
        {
            this.box_widget = this.create_box({
                container: document.body,
            });

            this.box_widget.container.classList.add("dropdown-box");
            this.box = this.box_widget.container;

            this.listener = new click_outside_listener([this.button, this.box], (target, {event}) => {
                if(!this.close_for_click(event))
                    return;

                this.visible = false;
            });

            if(this.close_on_click_inside)
                this.box.addEventListener("click", this.box_onclick);

            this._resize_observer = new ResizeObserver(() => {
                if(this._box_width == this.box.offsetWidth)
                    return;
    
                this._box_width = this.box.offsetWidth;
                this._align_to_button();
            });
            this._resize_observer.observe(this.box);
        
            // We manually position the dropdown, so we need to reposition them if
            // the window size changes.
            window.addEventListener("resize", this.onwindowresize, this._signal);

            this._align_to_button();
        }
        else
        {
            if(!this.box)
                return;

            this.box.removeEventListener("click", this.box_onclick);

            this._cleanup();

            if(this.box_widget)
            {
                this.box_widget.shutdown();
                this.box_widget = null;
            }
        }

        this.onvisibilitychanged(this);
    }

    _cleanup()
    {
        if(this._resize_observer)
        {
            this._resize_observer.disconnect();
            this._resize_observer = null;
        }

        if(this.listener)
        {
            this.listener.shutdown();
            this.listener = null;
        }

        window.removeEventListener("resize", this.onwindowresize);
    }

    _align_to_button()
    {
        if(!this.visible)
            return;

        // The amount of padding to leave relative to the button we're aligning to.
        let horizontal_padding = 4, vertical_padding = 8;

        // Use getBoundingClientRect to figure out the position, since it works
        // correctly with CSS transforms.  Figure out how far off we are and move
        // by that amount.  This works regardless of what our relative position is.
        //let {left: box_x, top: box_y} = this.box.getBoundingClientRect(document.body);
        let {left: button_x, top: button_y, height: box_height} = this.button.getBoundingClientRect();

        // Align to the left of the button.  Nudge left slightly for padding.
        let x = button_x - horizontal_padding;

        // If the right edge of the box is offscreen, push the box left.  Leave a bit of
        // padding on desktop, so the dropdown isn't flush with the edge of the window.
        // On mobile, allow the box to be flush with the edge.
        let padding = ppixiv.mobile? 0:4;
        let right_edge = x + this._box_width;
        x -= Math.max(right_edge - (window.innerWidth - padding), 0);

        // Don't push the left edge past the left edge of the screen.
        x = Math.max(x, 0);

        let y = button_y;

        this.box.style.left = `${x}px`;

        // Put the dropdown below the button if we're on the top half of the screen, otherwise
        // put it above.
        if(y < window.innerHeight / 2)
        {
            // Align to the bottom of the button, adding a bit of padding.
            y += box_height + vertical_padding;
            this.box.style.top = `${y}px`;
            this.box.style.bottom = "";

            // Set the box's maxHeight so it doesn't cross the bottom of the screen.
            // On desktop, add a bit of padding so it's not flush against the edge.
            let height = window.innerHeight - y - padding;
            this.box.style.maxHeight = `${height}px`;
        }
        else
        {
            y -= vertical_padding;

            // Align to the top of the button.
            this.box.style.top = "";
            this.box.style.bottom = `calc(100% - ${y}px)`;

            // Set the box's maxHeight so it doesn't cross the top of the screen.
            let height = y - padding;
            this.box.style.maxHeight = `${height}px`;
        }
    }

    shutdown()
    {
        super.shutdown();

        this._cleanup();
    }

    // Return true if this popup should close when clicking inside it.  If false,
    // the menu will stay open until something else closes it.
    get close_on_click_inside() { return false; }
}

// A specialization of dropdown_box_opener for buttons that open dropdowns containing
// lists of buttons, which we use a lot for data source UIs.
ppixiv.dropdown_menu_opener = class extends ppixiv.dropdown_box_opener
{
    // When button is clicked, show box.
    constructor({
        create_box=null,

        ...options
    })
    {
        super({
            // Wrap create_box() to add the popup-menu-box class.
            create_box: (...args) => {
                let widget = create_box(...args);
                widget.container.classList.add("popup-menu-box");
                return widget;
            },

            ...options
        });

        this.button.addEventListener("click", (e) => this.button_onclick(e), this._signal);

        this.set_button_popup_highlight();
    }

    get close_on_click_inside() { return true; }

    set visible(value)
    {
        super.visible = value;

        if(this.box)
        {
            // If we're inside a .top-ui-box container (the UI that sits at the top of the screen), set
            // .force-open on that element while we're open.
            let top_ui_box = this.box.closest(".top-ui-box");
            if(top_ui_box)
                helpers.set_class(top_ui_box, "force-open", value);
        }
    }

    get visible() { return super.visible; }

    // Close the popup when something inside is clicked.  This can be prevented with
    // stopPropagation, or with the keep-menu-open class.
    box_onclick = (e) =>
    {
        if(e.target.closest(".keep-menu-open"))
            return;

        this.visible = false;
    }

    // Toggle the popup when the button is clicked.
    button_onclick(e)
    {
        e.preventDefault();
        e.stopPropagation();
        this.visible = !this.visible;
    }

    // Set the text and highlight on button based on the contents of the box.
    //
    // The data_source dropdowns originally created all of their contents, then we set the
    // button text by looking at the contents.  We now create the popups on demand, but we
    // still want to set the button based on the selection.  Do this by creating a temporary
    // dropdown so we can see what gets set.  This is tightly tied to data_source.set_item.
    set_button_popup_highlight()
    {
        let temp_box = this.create_box({container: document.body});
        ppixiv.dropdown_menu_opener.set_active_popup_highlight_from(this.button, temp_box.container);
        temp_box.shutdown();
    }

    static set_active_popup_highlight_from(button, box)
    {
        // Find the selected item in the dropdown, if any.
        let selected_item = box.querySelector(".selected");
        let selected_default = selected_item == null || selected_item.dataset["default"];

        // If an explicit default button exists, there's usually always something selected in the
        // list: either a filter is selected or the default is.  If a list has a default button
        // but nothing is selected at all, that means we're not on any of the available selections
        // (we don't even match the default).  For example, this can happen if "This Week" is selected,
        // but some time has passed, so the time range the "This Week" menu item points to doesn't match
        // the search.  (That means we're viewing "some week in the past", but we don't have a menu item
        // for it.)
        //
        // If this happens, show the dropdown as selected, even though none of its items are active, to
        // indicate that a filter really is active and the user can reset it.
        let item_has_default = box.querySelector("[data-default]") != null;
        if(item_has_default && selected_item == null)
            selected_default = false;

        helpers.set_class(button, "selected", !selected_default);
        helpers.set_class(box, "selected", !selected_default);

        // If an option is selected, replace the menu button text with the selection's label.
        if(!selected_default)
        {
            // The short label is used to try to keep these labels from causing the menu buttons to
            // overflow the container, and for labels like "2 years ago" where the menu text doesn't
            // make sense.
            //
            // If we don't have a selected item, we're in the item_has_default case (see above).
            let text = selected_item?.dataset?.shortLabel;
            let selected_label = selected_item?.querySelector(".label")?.innerText;
            let label = button.querySelector(".label");
            label.innerText = text ?? selected_label ?? "Other";
        }
    }    
};

ppixiv.checkbox_widget = class extends ppixiv.widget
{
    constructor({
        value=false,
        ...options})
    {
        super({...options, template: `
            ${ helpers.create_icon("", { classes: ["checkbox"] }) }
        `});

        this._checked = true;
    };

    set checked(value)
    {
        if(this._checked == value)
            return;

        this._checked = value;
        this.refresh();
    }
    get checked() { return this._checked; }

    async refresh()
    {
        this.container.innerText = this.checked? "check_box":"check_box_outline_blank";
    }
};

// A pointless creepy eye.  Looks away from the mouse cursor when hovering over
// the unfollow button.
let creepy_eye_widget = class extends ppixiv.widget
{
    constructor({
        ...options
    }={})
    {
        super({...options, template: `
            <ppixiv-inline src="resources/eye-icon.svg"></ppixiv-inline>
        `});

        this.container.addEventListener("mouseenter", this.onevent);
        this.container.addEventListener("mouseleave", this.onevent);
        this.container.addEventListener("mousemove", this.onevent);
    }

    onevent = (e) =>
    {
        if(e.type == "mouseenter")
            this.hover = true;
        if(e.type == "mouseleave")
            this.hover = false;

        let eye_middle = this.container.querySelector(".middle");

        if(!this.hover)
        {
            eye_middle.style.transform = "";
            return;
        }
        let mouse = [e.clientX, e.clientY];

        let bounds = this.container.getBoundingClientRect();
        let eye = [bounds.x + bounds.width/2, bounds.y + bounds.height/2];

        let vector_length = (vec) =>Math.sqrt(vec[0]*vec[0] + vec[1]*vec[1]);

        // Normalize to get a direction vector.
        let normalize_vector = (vec) =>
        {
            var length = vector_length(vec);
            if(length < 0.0001)
                return [0,0];
            return [vec[0]/length, vec[1]/length];
        };

        let pos = [mouse[0] - eye[0], mouse[1] - eye[1]];
        pos = normalize_vector(pos);

        if(Math.abs(pos[0]) < 0.5)
        {
            let negative = pos[0] < 0;
            pos[0] = 0.5;
            if(negative)
                pos[0] *= -1;
        }
//        pos[0] = 1 - ((1-pos[0]) * (1-pos[0]));
        pos[0] *= -3;
        pos[1] *= -6;
        eye_middle.style.transform = "translate(" + pos[0] + "px, " + pos[1] + "px)";
    }
}

ppixiv.avatar_widget = class extends widget
{
    constructor({
        // If true, show the big avatar instead of the small one.
        big=false,

        // If true, handle clicks and show the follow dropdown.  If false, this is just an
        // avatar image.
        interactive=true,

        // This is called when the follow dropdown visibility changes.
        dropdownvisibilitychanged=() => { },

        ...options
    }={})
    {
        super({...options, template: `
            <div class=avatar-widget-follow-container>
                <a href=# class=avatar-link>
                    <canvas class=avatar></canvas>

                    <div class=follow-icon>
                        <ppixiv-inline src="resources/eye-icon.svg"></ppixiv-inline>
                    </div>
                </a>
            </div>
        `});

        this.options = options;
        if(this.options.mode != "dropdown" && this.options.mode != "overlay")
            throw "Invalid avatar widget mode";

        helpers.set_class(this.container, "big", big);

        user_cache.addEventListener("usermodified", this.user_changed, { signal: this.shutdown_signal.signal });

        let element_author_avatar = this.container.querySelector(".avatar");
        let avatar_link = this.container.querySelector(".avatar-link");

        if(interactive)
        {
            this.follow_dropdown_opener = new ppixiv.dropdown_box_opener({
                button: avatar_link,
                onvisibilitychanged: dropdownvisibilitychanged,
                create_box: ({...options}) => {
                    this.follow_widget = new ppixiv.follow_widget({
                        ...options,
                        user_id: this.user_id,
                    });

                    return this.follow_widget;
                },
            });

            avatar_link.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.follow_dropdown_opener.visible = !this.follow_dropdown_opener.visible;
            }, {
                // Hack: capture this event so we get clicks even over the eye widget.  We can't
                // set it to pointer-events: none since it reacts to mouse movement.
                capture: true,
            });

            // Clicking the avatar used to go to the user page, but now it opens the follow dropdown.
            // Allow doubleclicking it instead, to keep it quick to go to the user.
            avatar_link.addEventListener("dblclick", (e) => {
                e.preventDefault();
                e.stopPropagation();

                let args = new helpers.args(`/users/${this.user_id}/artworks#ppixiv`);
                helpers.navigate(args);
            });
        }

        // A canvas filter for the avatar.  This has no actual filters.  This is just to kill off any
        // annoying GIF animations in people's avatars.
        this.img = document.createElement("img");
        this.base_filter = new image_canvas_filter(this.img, element_author_avatar);
        
        this.container.dataset.mode = this.options.mode;

        // Show the favorite UI when hovering over the avatar icon.
        let avatar_popup = this.container; //container.querySelector(".avatar-popup");
        if(this.options.mode == "dropdown")
        {
            avatar_popup.addEventListener("mouseover", (e) => { helpers.set_class(avatar_popup, "popup-visible", true); });
            avatar_popup.addEventListener("mouseout", (e) => { helpers.set_class(avatar_popup, "popup-visible", false); });
        }

        new creepy_eye_widget({
            container: this.container.querySelector(".follow-icon .eye-image")
        });
    }

    visibility_changed()
    {
        super.visibility_changed();

        this.refresh();
    }

    // Refresh when the user changes.
    user_changed = ({user_id}) =>
    {
        if(this.user_id == null || this.user_id != user_id)
            return;

        this.set_user_id(this.user_id);
    }

    async set_user_id(user_id)
    {
        if(this.user_id == user_id)
            return;
        this.user_id = user_id;
        if(this.follow_dropdown_opener)
            this.follow_dropdown_opener.visible = false;
        this.refresh();
    }

    async refresh()
    {
        if(this.user_id == null || this.user_id == -1)
        {
            this.user_data = null;
            this.container.classList.add("loading");

            // Set the avatar image to a blank image, so it doesn't flash the previous image
            // the next time we display it.  It should never do this, since we set a new image
            // before displaying it, but Chrome doesn't do this correctly at least with canvas.
            this.img.src = helpers.blank_image;
            return;
        }

        // If we've seen this user's profile image URL from thumbnail data, start loading it
        // now.  Otherwise, we'll have to wait until user info finishes loading.
        let cached_profile_url = ppixiv.media_cache.user_profile_urls[this.user_id];
        if(cached_profile_url)
            this.img.src = cached_profile_url;

        // Set up stuff that we don't need user info for.
        this.container.querySelector(".avatar-link").href = `/users/${this.user_id}/artworks#ppixiv`;

        // Hide the popup in dropdown mode, since it covers the dropdown.
        if(this.options.mode == "dropdown")
            this.container.querySelector(".avatar").classList.remove("popup");

        // Clear stuff we need user info for, so we don't show old data while loading.
        helpers.set_class(this.container, "followed", false);
        this.container.querySelector(".avatar").dataset.popup = "";

        this.container.classList.remove("loading");
        this.container.querySelector(".follow-icon").hidden = true;

        let user_data = await user_cache.get_user_info(this.user_id);
        this.user_data = user_data;
        if(user_data == null)
            return;

        this.container.querySelector(".follow-icon").hidden = !this.user_data.isFollowed;
        this.container.querySelector(".avatar").dataset.popup = this.user_data.name;

        // If we don't have an image because we're loaded from a source that doesn't give us them,
        // just hide the avatar image.
        let key = "imageBig";
        if(this.user_data[key])
            this.img.src = this.user_data[key];
        else
            this.img.src = helpers.blank_image;
    }
};

ppixiv.follow_widget = class extends widget
{
    constructor({
        user_id=null,
        ...options
    })
    {
        super({
            ...options, template: `
            <div class="follow-container vertical-list">
                ${helpers.create_box_link({
                    label: "View posts",
                    icon: "image",
                    classes: ["view-posts"],
                })}

                <!-- Buttons for following and unfollowing: -->
                ${helpers.create_box_link({
                    label: "Follow",
                    icon: "public",
                    classes: ["follow-button-public"],
                })}

                ${helpers.create_box_link({
                    label: "Follow privately",
                    icon: "lock",
                    classes: ["follow-button-private"],
                })}

                ${helpers.create_box_link({
                    label: "Unfollow",
                    icon: "delete",
                    classes: ["unfollow-button"],
                })}

                <!-- Buttons for toggling a follow between public and private.  This is separate
                     from the buttons above, since it comes after to make sure that the unfollow
                     button is above the toggle buttons. -->
                ${helpers.create_box_link({
                    label: "Change to public",
                    icon: "public",
                    classes: ["toggle-follow-button-public"],
                })}

                ${helpers.create_box_link({
                    label: "Change to private",
                    icon: "lock",
                    classes: ["toggle-follow-button-private"],
                })}

                <!-- A separator before follow tags.  Hide this if the user doesn't have premium,
                     since he won't have access to tags and this will be empty. -->
                <div class="separator premium-only"><div></div></div>

                ${helpers.create_box_link({
                    label: "Add new tag",
                    icon: "add_circle",
                    classes: ["premium-only", "add-follow-tag"],
                })}

                <vv-container class=follow-tag-list></vv-container>
            </div>
        `});

        this._user_id = user_id;

        this.container.querySelector(".follow-button-public").addEventListener("click", (e) => this.clicked_follow(false));
        this.container.querySelector(".follow-button-private").addEventListener("click", (e) => this.clicked_follow(true));
        this.container.querySelector(".toggle-follow-button-public").addEventListener("click", (e) => this.clicked_follow(false));
        this.container.querySelector(".toggle-follow-button-private").addEventListener("click", (e) => this.clicked_follow(true));
        this.container.querySelector(".unfollow-button").addEventListener("click", (e) => this.clicked_unfollow());
        this.container.querySelector(".add-follow-tag").addEventListener("click", (e) => this.add_follow_tag());

        // Refresh if the user we're displaying changes.
        user_cache.addEventListener("usermodified", this.user_changed, this._signal);
    }

    user_changed = ({user_id}) =>
    {
        if(!this.visible || user_id != this.user_id)
            return;

        this.refresh();
    };

    set user_id(value)
    {
        if(this._user_id == value)
            return;

        this._user_id = value;
        if(value == null)
            this.visible = false;
    }
    get user_id() { return this._user_id; }

    async refresh()
    {
        if(!this.visible)
            return;

        if(this.refreshing)
        {
            console.error("Already refreshing");
            return;
        }

        this.refreshing = true;
        try {
            if(this._user_id == null)
            {
                console.log("Follow widget has no user ID");
                return;
            }
            
            // Refresh with no data.
            this.refresh_with_data();

            // Refresh with whether we're followed or not, so the follow/unfollow UI is
            // displayed as early as possible.
            let user_info = await user_cache.get_user_info(this.user_id);
            if(!this.visible)
                return;

            this.refresh_with_data({ user_info, following: user_info.isFollowed });
            
            if(!user_info.isFollowed)
            {
                // We're not following, so just load the follow tag list.
                let all_tags = await user_cache.load_all_user_follow_tags();
                this.refresh_with_data({ user_info, following: user_info.isFollowed, all_tags, selected_tags: new Set() });
                return;
            }

            // Get full follow info to find out if the follow is public or private, and which
            // tags are selected.
            let follow_info = await user_cache.get_user_follow_info(this.user_id);
            let all_tags = await user_cache.load_all_user_follow_tags();
            this.refresh_with_data({user_info, following: true, following_privately: follow_info?.following_privately, all_tags, selected_tags: follow_info?.tags});
        } finally {
            this.refreshing = false;
        }
    }

    // Refresh the UI with as much data as we have.  This data comes in a bunch of little pieces,
    // so we get it incrementally.
    refresh_with_data({user_info=null, following=null, following_privately=null, all_tags=null, selected_tags=null}={})
    {
        if(!this.visible)
            return;

        this.container.querySelector(".follow-button-public").hidden = true;
        this.container.querySelector(".follow-button-private").hidden = true;
        this.container.querySelector(".toggle-follow-button-public").hidden = true;
        this.container.querySelector(".toggle-follow-button-private").hidden = true;
        this.container.querySelector(".unfollow-button").hidden = true;
        this.container.querySelector(".add-follow-tag").hidden = true;
        this.container.querySelector(".separator").hidden = true;
        
        let view_text = user_info != null? `View ${user_info.name}'s posts`:`View posts`;
        this.container.querySelector(".view-posts .label").innerText = view_text;
        this.container.querySelector(".view-posts").href = `/users/${this._user_id}/artworks#ppixiv`;

        // If following is null, we're still waiting for the initial user data request
        // and we don't have any data yet.  
        if(following == null)
            return;

        if(following)
        {
            // If we know whether we're following privately or publically, we can show the
            // button to change the follow mode.  If we don't have that yet, we can only show
            // unfollow.
            if(following_privately != null)
            {
                this.container.querySelector(".toggle-follow-button-public").hidden = !following_privately;
                this.container.querySelector(".toggle-follow-button-private").hidden = following_privately;
            }

            this.container.querySelector(".unfollow-button").hidden = false;
        }
        else
        {
            this.container.querySelector(".follow-button-public").hidden = false;
            this.container.querySelector(".follow-button-private").hidden = false;
        }

        // If we've loaded follow tags, fill in the list.
        for(let element of this.container.querySelectorAll(".follow-tag"))
            element.remove();

        if(all_tags != null)
        {
            // Show the separator and "add tag" button once we have the tag list.
            this.container.querySelector(".add-follow-tag").hidden = false;
            this.container.querySelector(".separator").hidden = false;

            all_tags.sort((lhs, rhs) => lhs.toLowerCase().localeCompare(rhs.toLowerCase()));
            for(let tag of all_tags)
            {
                let button = helpers.create_box_link({
                    label: tag,
                    classes: ["follow-tag"],
                    icon: "bookmark",
                    as_element: true,
                });
    
                // True if the user is bookmarked with this tag.
                let selected = selected_tags.has(tag);
                helpers.set_class(button, "selected", selected);

                this.container.appendChild(button);

                button.addEventListener("click", (e) => {
                    this.toggle_follow_tag(tag);
                });
            }
        }
    }

    async clicked_follow(follow_privately)
    {
        await actions.follow(this._user_id, follow_privately);
    }

    async clicked_unfollow()
    {
        await actions.unfollow(this._user_id);
    }

    async add_follow_tag()
    {
        let prompt = new text_prompt({ title: "New folder:" });
        let folder = await prompt.result;
        if(folder == null)
            return; // cancelled

        await this.toggle_follow_tag(folder);
    }

    async toggle_follow_tag(tag)
    {
        // Make a copy of user_id, in case it changes while we're async.
        let user_id = this.user_id;

        // If the user isn't followed, the first tag is added by following.
        let user_data = await user_cache.get_user_info(user_id);
        if(!user_data.isFollowed)
        {
            // We're not following, so follow the user with default privacy and the
            // selected tag.
            await actions.follow(user_id, null, { tag });
            return;
        }

        // We're already following, so update the existing tags.
        let follow_info = await user_cache.get_user_follow_info(user_id);
        if(follow_info == null)
        {
            console.log("Error retrieving follow info to update tags");
            return;
        }

        let tag_was_selected = follow_info.tags.has(tag);
        actions.change_follow_tags(user_id, {tag: tag, add: !tag_was_selected});
    }
};

// A list of tags, with translations in popups where available.
ppixiv.tag_widget = class extends ppixiv.widget
{
    constructor({...options})
    {
        super({...options});
    };

    format_tag_link(tag)
    {
        return ppixiv.helpers.get_args_for_tag_search(tag, ppixiv.plocation);
    };

    async set(tags)
    {
        this.tags = tags;
        this.refresh();
    }

    async refresh()
    {
        if(this.tags == null)
            return;

        // Short circuit if the tag list isn't changing, since IndexedDB is really slow.
        if(this.last_tags != null && JSON.stringify(this.last_tags) == JSON.stringify(this.tags))
            return;

        // Look up tag translations.
        let tag_list = this.tags;
        let translated_tags = await tag_translations.get().get_translations(tag_list, "en");
        
        // Stop if the tag list changed while we were reading tag translations.
        if(tag_list != this.tags)
            return;

        this.last_tags = this.tags;

        // Remove any old tag list and create a new one.
        helpers.remove_elements(this.container);

        for(let tag of tag_list)
        {
            let translated_tag = tag;
            if(translated_tags[tag])
                translated_tag = translated_tags[tag];

            let a = helpers.create_box_link({
                label: translated_tag,
                classes: ["tag-entry"],
                link: this.format_tag_link(tag),
                as_element: true,
            });

            this.container.appendChild(a);

            a.dataset.tag = tag;
        }
    }
};

// A popup for inputting text.
//
// This is currently special purpose for the add tag prompt.
ppixiv.text_prompt = class extends ppixiv.dialog_widget
{
    static async prompt(options)
    {
        let prompt = new this(options);
        return await prompt.result;
    }

    constructor({
        title,
        value="",
        ...options
    }={})
    {
        super({...options, dialog_class: "text-entry-popup", small: true, header: title, template: `
            <div class=input-box>
                <div class=editor contenteditable></div>
                <span class=submit-button>${ helpers.create_icon("mat:check") }</span>
            </div>
        `});
        
        this.result = new Promise((completed, cancelled) => {
            this._completed = completed;
        });

        this.input = this.container.querySelector(".editor");

        // Set text by creating a node manually, since textContent won't create a node if value is "".
        this.input.appendChild(document.createTextNode(value));

        this.container.querySelector(".submit-button").addEventListener("click", this.submit);
    }

    handle_keydown = (e) =>
    {
        if(super.handle_keydown(e))
            return true;

        // The escape key is handled by dialog_widget.
        if(e.key == "Enter")
        {
            this.submit();
            return true;
        }

        return false;
    }

    visibility_changed()
    {
        super.visibility_changed();

        if(this.visible)
        {
            window.addEventListener("keydown", this.onkeydown, { signal: this.visibility_abort.signal });

            // Focus when we become visible.
            this.input.focus();

            // Move the cursor to the end.
            let size = this.input.firstChild.length;
            window.getSelection().setBaseAndExtent(this.input.firstChild, size, this.input.firstChild, size);
        }
        else
        {
            // If we didn't complete by now, cancel.
            this._completed(null);
        }
    }

    // Close the popup and call the completion callback with the result.
    submit = () =>
    {
        let result = this.input.textContent;
        this._completed(result);

        this.visible = false;
    }
}

ppixiv.confirm_prompt = class extends ppixiv.dialog_widget
{
    static async prompt(options)
    {
        let prompt = new this(options);
        return await prompt.result;
    }

    constructor({
        header,
        text,
        ...options
    }={})
    {
        super({...options, dialog_class: "confirm-dialog", allow_close: false, small: true, header,
        template: `
            <div class=text hidden></div>
            <div class=input-box>
                ${helpers.create_box_link({
                    label: "Yes",
                    icon: "image",
                    classes: ["yes"],
                })}

                ${helpers.create_box_link({
                    label: "No",
                    icon: "image",
                    classes: ["no"],
                })}
            </div>
        `});
        
        if(text)
        {
            let text_node = this.container.querySelector(".text");
            text_node.innerText = text;
            text_node.hidden = false;
        }

        this.result = new Promise((completed, cancelled) => {
            this._completed = completed;
        });

        this.container.querySelector(".yes").addEventListener("click", () => this.submit(true), { signal: this.shutdown_signal.signal });
        this.container.querySelector(".no").addEventListener("click", () => this.submit(false), { signal: this.shutdown_signal.signal });
    }

    onkeydown = (e) =>
    {
        if(e.key == "Escape")
        {
            e.preventDefault();
            e.stopPropagation();
            this.submit(false);
        }

        if(e.key == "Enter")
        {
            e.preventDefault();
            e.stopPropagation();
            this.submit(true);
        }
    }

    visibility_changed()
    {
        super.visibility_changed();

        if(this.visible)
        {
            window.addEventListener("keydown", this.onkeydown, { signal: this.visibility_abort.signal });
        }
        else
        {
            // If we didn't complete by now, cancel.
            this._completed(null);
        }
    }

    // Close the popup and call the completion callback with the result.
    submit = (result) =>
    {
        this._completed(result);

        this.visible = false;
    }
}

// Widget for editing bookmark tags.
ppixiv.bookmark_tag_list_widget = class extends ppixiv.illust_widget
{
    get needed_data() { return "media_id"; }

    constructor({...options})
    {
        super({...options, template: `
            <div class="bookmark-tag-list">
                <div class=tag-list>
                </div>
            </div>
        `});

        this.displaying_media_id = null;
        this.container.addEventListener("click", this.clicked_bookmark_tag, true);
        this.deactivated = false;

        settings.addEventListener("recent-bookmark-tags", this.refresh.bind(this));
    }

    // Deactivate this widget.  We won't refresh or make any bookmark changes after being
    // deactivated.  This is used by the bookmark button widget.  The widget will become
    // active again the next time it's displayed.
    deactivate()
    {
        this.deactivated = true;
    }

    shutdown()
    {
        // If we weren't hidden before being shut down, set ourselves hidden so we save any
        // changes.
        this.visible = false;

        super.shutdown();
    }

    // Return an array of tags selected in the tag dropdown.
    get selected_tags()
    {
        var tag_list = [];
        var bookmark_tags = this.container;
        for(var entry of bookmark_tags.querySelectorAll(".popup-bookmark-tag-entry"))
        {
            if(!entry.classList.contains("selected"))
                continue;
            tag_list.push(entry.dataset.tag);
        }
        return tag_list;
    }

    // Override setting media_id to save tags when we're closed.  Otherwise, media_id will already
    // be cleared when we close and we won't be able to save.
    set_media_id(media_id)
    {
        // If we're hiding and were previously visible, save changes.
        if(media_id == null)
            this.save_current_tags();

        super.set_media_id(media_id);
    }
    
    async visibility_changed()
    {
        super.visibility_changed();

        if(this.visible)
        {
            // If we were deactivated, reactivate when we become visible again.
            if(this.deactivated)
                console.info("reactivating tag list widget");

            this.deactivated = false;

            // We only load existing bookmark tags when the tag list is open, so refresh.
            await this.refresh();
        }
        else
        {
            // Save any selected tags when the dropdown is closed.
            this.save_current_tags();

            // Clear the tag list when the menu closes, so it's clean on the next refresh.
            this.clear_tag_list();

            this.displaying_media_id = null;
        }
    }

    clear_tag_list()
    {
        // Make a copy of children when iterating, since it doesn't handle items being deleted
        // while iterating cleanly.
        let bookmark_tags = this.container.querySelector(".tag-list");
        for(let element of [...bookmark_tags.children])
        {
            if(element.classList.contains("dynamic") || element.classList.contains("loading"))
                element.remove();
        }
    }

    async refresh_internal({ media_id })
    {
        if(this.deactivated)
            return;

        // If we're refreshing the same illust that's already refreshed, store which tags were selected
        // before we clear the list.
        let old_selected_tags = this.displaying_media_id == media_id? this.selected_tags:[];

        this.displaying_media_id = null;

        let bookmark_tags = this.container.querySelector(".tag-list");
        this.clear_tag_list();

        if(media_id == null || !this.visible)
            return;

        // Create a temporary entry to show loading while we load bookmark details.
        let entry = document.createElement("span");
        entry.classList.add("loading");
        bookmark_tags.appendChild(entry);
        entry.innerText = "Loading...";

        // If the tag list is open, populate bookmark details to get bookmark tags.
        // If the image isn't bookmarked this won't do anything.
        let active_tags = await extra_cache.singleton().load_bookmark_details(media_id);

        // Remember which illustration's bookmark tags are actually loaded.
        this.displaying_media_id = media_id;

        // Remove elements again, in case another refresh happened while we were async
        // and to remove the loading entry.
        this.clear_tag_list();
        
        // If we're refreshing the list while it's open, make sure that any tags the user
        // selected are still in the list, even if they were removed by the refresh.  Put
        // them in active_tags, so they'll be marked as active.
        for(let tag of old_selected_tags)
        {
            if(active_tags.indexOf(tag) == -1)
                active_tags.push(tag);
        }

        let shown_tags = [];

        let recent_bookmark_tags = Array.from(helpers.get_recent_bookmark_tags()); // copy
        for(let tag of recent_bookmark_tags)
            if(shown_tags.indexOf(tag) == -1)
                shown_tags.push(tag);

        // Add any tags that are on the bookmark but not in recent tags.
        for(let tag of active_tags)
            if(shown_tags.indexOf(tag) == -1)
                shown_tags.push(tag);

        shown_tags.sort((lhs, rhs) => lhs.toLowerCase().localeCompare(rhs.toLowerCase()));

        let create_entry = (tag, { classes=[], icon }={}) =>
        {
            let entry = this.create_template({name: "tag-entry", html: `
                <div class="popup-bookmark-tag-entry dynamic">
                    <span class=tag-name></span>
                </div>
            `});

            for(let cls of classes)
                entry.classList.add(cls);
            entry.querySelector(".tag-name").innerText = tag;

            if(icon)
                entry.querySelector(".tag-name").insertAdjacentElement("afterbegin", icon);
            bookmark_tags.appendChild(entry);

            return entry;
        }

        let add_button = create_entry("Add", {
            icon: helpers.create_icon("add", { as_element: true }),
            classes: ["add-button"],
        });
        add_button.addEventListener("click", () => actions.add_new_tag(this._media_id));

        for(let tag of shown_tags)
        {
            let entry = create_entry(tag, {
                classes: ["tag-toggle"],
//                icon: helpers.create_icon("ppixiv:tag", { as_element: true }),
            });

            entry.dataset.tag = tag;

            let active = active_tags.indexOf(tag) != -1;
            helpers.set_class(entry, "selected", active);
        }

        let sync_button = create_entry("Refresh", {
            icon: helpers.create_icon("refresh", { as_element: true }),
            classes: ["refresh-button"],
        });

        sync_button.addEventListener("click", async (e) => {
            let bookmark_tags = await actions.load_recent_bookmark_tags();
            helpers.set_recent_bookmark_tags(bookmark_tags);
        });
    }

    // Save the selected bookmark tags to the current illust.
    async save_current_tags()
    {
        if(this.deactivated)
            return;

        // Store the ID and tag list we're saving, since they can change when we await.
        let media_id = this._media_id;
        let new_tags = this.selected_tags;
        if(media_id == null)
            return;

        // Only save tags if we're refreshed to the current illust ID, to make sure we don't save
        // incorrectly if we're currently waiting for the async refresh.
        if(media_id != this.displaying_media_id)
            return;

        // Get the tags currently on the bookmark to compare.
        let old_tags = await extra_cache.singleton().load_bookmark_details(media_id);

        var equal = new_tags.length == old_tags.length;
        for(let tag of new_tags)
        {
            if(old_tags.indexOf(tag) == -1)
                equal = false;
        }
        // If the selected tags haven't changed, we're done.
        if(equal)
            return;
        
        // Save the tags.  If the image wasn't bookmarked, this will create a public bookmark.
        console.log(`Tag list closing and tags have changed: ${old_tags.join(",")} -> ${new_tags.join(",")}`);
        await actions.bookmark_add(this._media_id, {
            tags: new_tags,
        });
    }

    // Toggle tags on click.  We don't save changes until we're closed.
    clicked_bookmark_tag = async(e) =>
    {
        if(this.deactivated)
            return;

        let a = e.target.closest(".tag-toggle");
        if(a == null)
            return;

        e.preventDefault();
        e.stopPropagation();

        // Toggle this tag.  Don't actually save it immediately, so if we make multiple
        // changes we don't spam requests.
        let tag = a.dataset.tag;
        helpers.set_class(a, "selected", !a.classList.contains("selected"));
    }
}

// A bookmark tag list in a dropdown.
//
// The base class is a simple widget.  This subclass handles some of the trickier
// bits around closing the dropdown correctly, and tells any bookmark buttons about
// itself.
ppixiv.bookmark_tag_list_dropdown_widget = class extends ppixiv.bookmark_tag_list_widget
{
    constructor({
        media_id,
        bookmark_buttons,
        ...options
    })
    {
        super({
            classes: ["popup-bookmark-tag-dropdown"],
            ...options
        });

        this.container.classList.add("popup-bookmark-tag-dropdown");

        this.bookmark_buttons = bookmark_buttons;

        this.set_media_id(media_id);

        // Let the bookmark buttons know about this bookmark tag dropdown, and remove it when
        // it's closed.
        for(let bookmark_button of this.bookmark_buttons)
            bookmark_button.bookmark_tag_list_widget = this;
    }

    async refresh_internal({ media_id })
    {
        // Make sure the dropdown is hidden if we have no image.
        if(media_id == null)
            this.visible = false;

        await super.refresh_internal({ media_id });
    }

    // Hide if our tree becomes hidden.
    on_visible_recursively_changed()
    {
        super.on_visible_recursively_changed();

        if(!this.visible_recursively)
            this.visible = false;
    }

    shutdown()
    {
        super.shutdown();

        for(let bookmark_button of this.bookmark_buttons)
        {
            if(bookmark_button.bookmark_tag_list_widget == this)
                bookmark_button.bookmark_tag_list_widget = null;
        }
    }
}

// This opens the bookmark tag dropdown when a button is pressed.
ppixiv.bookmark_tag_dropdown_opener = class extends ppixiv.actor
{
    constructor({
        // The bookmark tag button which opens the dropdown.
        bookmark_tags_button,

        // The associated bookmark button widgets, if any.
        bookmark_buttons,
        
        onvisibilitychanged,
        ...options
    })
    {
        super({...options});

        this.bookmark_buttons = bookmark_buttons;
        this._media_id = null;

        // Create an opener to actually create the dropdown.
        this._opener = new ppixiv.dropdown_box_opener({
            button: bookmark_tags_button,
            onvisibilitychanged,
            create_box: this._create_box,

            // If we have bookmark buttons, don't close for clicks inside them.  We need the
            // bookmark button to handle the click first, then it'll close us.
            close_for_click: (e) =>
            {
                for(let button of this.bookmark_buttons)
                {
                    if(helpers.is_above(button.container, e.target))
                        return false;
                }

                return true;
            },
        });

        bookmark_tags_button.addEventListener("click", (e) => {
            this._opener.visible = !this._opener.visible;
        });

        for(let button of this.bookmark_buttons)
        {
            button.addEventListener("bookmarkedited", () => {
                this._opener.visible = false;
            }, this._signal);
        }
    }

    set_media_id(media_id)
    {
        if(this._media_id == media_id)
            return;

        this._media_id = media_id;

        // Hide the dropdown if the image changes while it's open.
        this._opener.visible = false;
    }

    _create_box = ({...options}) => {
        if(this._media_id == null)
            throw new Error("Media ID not set");

        return new ppixiv.bookmark_tag_list_dropdown_widget({
            ...options,
            parent: this,
            media_id: this._media_id,
            bookmark_buttons: this.bookmark_buttons,
        });
    }

    set visible(value) { this._opener.visible = value; }
    get visible() { return this._opener.visible; }
}

ppixiv.more_options_dropdown_widget = class extends ppixiv.illust_widget
{
    get needed_data() { return "partial"; }

    constructor({ ...options })
    {
        super({...options,
            template: `
                <div class="more-options-dropdown">
                    <div class="options vertical-list" style="min-width: 13em;"></div>
                </div>
        `});

        this.menu_options = [];
    }

    // This is called before we become visible if alt is held while our button is pressed.
    // We use this to hide some rarely-used options.
    set_alt_pressed(pressed)
    {
        this.show_extra = pressed;
    }

    create_menu_options()
    {
        let option_box = this.container.querySelector(".options");
        let shared_options = {
            container: option_box,
            parent: this,
        };

        for(let item of this.menu_options)
            item.container.remove();

        let menu_options = {
            similar_illustrations: () => {
                return new menu_option_button({
                    ...shared_options,
                    label: "Similar illustrations",
                    icon: "ppixiv:suggestions",
                    requires_image: true,
                    onclick: () => {
                        this.parent.hide();

                        let [illust_id] = helpers.media_id_to_illust_id_and_page(this.media_id);
                        let args = new helpers.args(`/bookmark_detail.php?illust_id=${illust_id}#ppixiv?recommendations=1`);
                        helpers.navigate(args);
                    }
                });
            },
            similar_artists: () => {
                return new menu_option_button({
                    ...shared_options,
                    label: "Similar artists",
                    icon: "ppixiv:suggestions",
                    requires_user: true,
                    onclick: () => {
                        this.parent.hide();

                        let args = new helpers.args(`/discovery/users#ppixiv?user_id=${this.user_id}`);
                        helpers.navigate(args);
                    }
                });
            },

            similar_local_images: () => {
                return new menu_option_button({
                    ...shared_options,
                    label: "Similar images",
                    icon: "ppixiv:suggestions",
                    requires_image: true,
                    onclick: () => {
                        this.parent.hide();

                        let args = new helpers.args("/");
                        args.path = "/similar";
                        args.hash_path = "/#/";
                        let { id } = helpers.parse_media_id(this.media_id);
                        args.hash.set("search_path", id);
                        helpers.navigate(args);
                    }
                });
            },
            
            similar_bookmarks: () => {
                return new menu_option_button({
                    ...shared_options,
                    label: "Similar bookmarks",
                    icon: "ppixiv:suggestions",
                    requires_image: true,
                    onclick: () => {
                        this.parent.hide();

                        let [illust_id] = helpers.media_id_to_illust_id_and_page(this.media_id);
                        let args = new helpers.args(`/bookmark_detail.php?illust_id=${illust_id}#ppixiv`);
                        helpers.navigate(args);
                    }
                });
            },

            index_folder: () => {
                return new menu_option_button({
                    ...shared_options,
                    label: "Index similarity",
                    icon: "ppixiv:suggestions",
                    hide_if_unavailable: true,
                    requires: ({media_id}) => {
                        if(media_id == null)
                            return false;
                        let { type } = helpers.parse_media_id(media_id);
                        return type == "folder";
                    },

                    onclick: () => {
                        this.parent.hide();
                        local_api.index_folder(this.media_id);
                    }
                });
            },

            edit_mutes: () => {
                return new menu_option_button({
                    ...shared_options,
                    label: "Edit mutes",

                    // Only show this entry if we have at least a media ID or a user ID.
                    requires: ({media_id, user_id}) => { return media_id != null || user_id != null; },

                    icon: "mat:block",

                    onclick: async () => {
                        this.parent.hide();
                        new muted_tags_for_post_popup({
                            media_id: this.media_id,
                            user_id: this.user_id,
                        });
                    }
                });
            },

            refresh_image: () => {
                return new menu_option_button({
                    ...shared_options,
                    label: "Refresh image",

                    requires_image: true,

                    icon: "mat:refresh",

                    onclick: async () => {
                        this.parent.hide();
                        ppixiv.media_cache.refresh_media_info(this.media_id);
                    }
                });
            },

            // XXX: hook into progress bar
            download_image: () => {
                return new menu_option_button({
                    ...shared_options,
                    label: "Download image",
                    icon: "mat:download",
                    hide_if_unavailable: true,
                    requires_image: true,
                    available: () => { return this.media_info && actions.is_download_type_available("image", this.media_info); },
                    onclick: () => {
                        actions.download_illust(this.media_id, "image");
                        this.parent.hide();
                    }
                });
            },

            download_manga: () => {
                return new menu_option_button({
                    ...shared_options,
                    label: "Download manga ZIP",
                    icon: "mat:download",
                    hide_if_unavailable: true,
                    requires_image: true,
                    available: () => { return this.media_info && actions.is_download_type_available("ZIP", this.media_info); },
                    onclick: () => {
                        actions.download_illust(this.media_id, "ZIP");
                        this.parent.hide();
                    }
                });
            },

            download_video: () => {
                return new menu_option_button({
                    ...shared_options,
                    label: "Download video MKV",
                    icon: "mat:download",
                    hide_if_unavailable: true,
                    requires_image: true,
                    available: () => { return this.media_info && actions.is_download_type_available("MKV", this.media_info); },
                    onclick: () => {
                        actions.download_illust(this.media_id, "MKV");
                        this.parent.hide();
                    }
                });
            },

            send_to_tab: () => {
                return new menu_option_button({
                    ...shared_options,
                    label: "Send to tab",
                    classes: ["button-send-image"],
                    icon: "mat:open_in_new",
                    requires_image: true,
                    onclick: () => {
                        new send_image_popup({ media_id: this.media_id });
                        this.parent.hide();
                    }
                });
            },

            toggle_slideshow: () => {
                return new menu_option_toggle({
                    ...shared_options,
                    label: "Slideshow",
                    icon: "mat:wallpaper",
                    requires_image: true,
                    checked: helpers.args.location.hash.get("slideshow") == "1",
                    onclick: () => {
                        main_controller.toggle_slideshow();
                        this.refresh();
                    },
                });
            },

            toggle_loop: () => {
                return new menu_option_toggle({
                    ...shared_options,
                    label: "Loop",
                    checked: helpers.args.location.hash.get("slideshow") == "loop",
                    icon: "mat:replay_circle_filled",
                    requires_image: true,
                    hide_if_unavailable: true,
                    onclick: () => {
                        main_controller.loop_slideshow();
                        this.refresh();
                    },
                });
            },

            linked_tabs: () => {
                let widget = new menu_option_toggle_setting({
                    container: option_box,
                    label: "Linked tabs",
                    setting: "linked_tabs_enabled",
                    icon: "mat:link",
                });
                
                new menu_option_button({
                    container: widget.container.querySelector(".checkbox"),
                    container_position: "beforebegin",
                    label: "Edit",
                    classes: ["small-font"],

                    onclick: (e) => {
                        e.stopPropagation();

                        new ppixiv.settings_dialog({ show_page: "linked_tabs" });

                        this.parent.hide();
                        return true;
                    },
                });

                return widget;
            },

            image_editing: () => {
                return new menu_option_toggle_setting({
                    ...shared_options,
                    label: "Image editing",
                    icon: "mat:brush",
                    setting: "image_editing",
                    requires_image: true,

                    onclick: () => {
                        // When editing is turned off, clear the editing mode too.
                        let enabled = settings.get("image_editing");
                        if(!enabled)
                            settings.set("image_editing_mode", null);
                    },
                });
            },

            open_settings: () => {
                return new menu_option_button({
                    ...shared_options,
                    label: "Settings",
                    icon: "mat:settings",
                    onclick: () => {
                        new ppixiv.settings_dialog();
                        this.parent.hide();
                    }
                });
            },

            exit: () => {
                return new menu_option_button({
                    ...shared_options,
                    label: "Return to Pixiv",
                    icon: "mat:logout",
                    url: "#no-ppixiv",
                });
            },
        };

        this.menu_options = [];
        if(!ppixiv.native)
        {
            this.menu_options.push(menu_options.similar_illustrations());
            this.menu_options.push(menu_options.similar_artists());
            if(this.show_extra)
                this.menu_options.push(menu_options.similar_bookmarks());
            
            this.menu_options.push(menu_options.download_image());
            this.menu_options.push(menu_options.download_manga());
            this.menu_options.push(menu_options.download_video());
            this.menu_options.push(menu_options.edit_mutes());
        }
        else
        {
            this.menu_options.push(menu_options.similar_local_images());
        }

        this.menu_options.push(menu_options.send_to_tab());
        this.menu_options.push(menu_options.linked_tabs());

        // These are in the top-level menu on mobile.  Don't show these if we're on the search
        // view either, since they want to actually be on the illust view, not hovering a thumbnail.
        let screen_name = main_controller.get_displayed_screen({ name: true })
        if(!ppixiv.mobile && screen_name == "illust")
        {
            this.menu_options.push(menu_options.toggle_slideshow());
            this.menu_options.push(menu_options.toggle_loop());
        }
        if(!ppixiv.mobile)
            this.menu_options.push(menu_options.image_editing());
        if(ppixiv.native)
            this.menu_options.push(menu_options.index_folder());
        if(this.show_extra || ppixiv.native)
            this.menu_options.push(menu_options.refresh_image());

        // Add settings for mobile.  On desktop, this is available in a bunch of other
        // higher-profile places.
        if(ppixiv.mobile)
            this.menu_options.push(menu_options.open_settings());

        if(!ppixiv.native && !ppixiv.mobile)
            this.menu_options.push(menu_options.exit());
    }

    set_user_id(user_id)
    {
        this.user_id = user_id;
        this.refresh();
    }

    visibility_changed()
    {
        if(this.visible)
            this.refresh();
    }

    // Hide if our tree becomes hidden.
    on_visible_recursively_changed()
    {
        super.on_visible_recursively_changed();

        if(!this.visible_recursively)
            this.visible = false;
    }

    async refresh_internal({ media_id, media_info })
    {
        if(!this.visible)
            return;

        this.create_menu_options();

        this.media_info = media_info;

        for(let option of this.menu_options)
        {
            let enable = true;
    
            // Enable or disable buttons that require an image.
            if(option.options.requires_image && media_id == null)
                enable = false;
            if(option.options.requires_user && this.user_id == null)
                enable = false;
            if(option.options.requires && !option.options.requires({media_id: media_id, user_id: this.user_id}))
                enable = false;
            if(enable && option.options.available)
                enable = option.options.available();
            option.enabled = enable;

            // Some options are hidden when they're unavailable, because they clutter
            // the menu too much.
            if(option.options.hide_if_unavailable)
                option.container.hidden = !enable;
        }
    }
}

ppixiv.bookmark_button_widget = class extends ppixiv.illust_widget
{
    get needed_data() { return "partial"; }

    constructor({
        // "public", "private" or "delete"
        bookmark_type,

        // If true, clicking a bookmark button that's already bookmarked will remove the
        // bookmark.  If false, the bookmark tags will just be updated.
        toggle_bookmark=true,

        // An associated bookmark_tag_list_widget.
        //
        // Bookmark buttons and the tag list widget both manipulate and can create bookmarks.  Telling
        // us about an active bookmark_tag_list_widget lets us prevent collisions.
        bookmark_tag_list_widget,

        ...options})
    {
        super({...options});

        this.bookmark_type = bookmark_type;
        this.toggle_bookmark = toggle_bookmark;
        this._bookmark_tag_list_widget = bookmark_tag_list_widget;

        this.container.addEventListener("click", this.clicked_bookmark);
    }

    // Dispatch bookmarkedited when we're editing a bookmark.  This lets any bookmark tag
    // dropdowns know they should close.
    _fire_onedited()
    {
        this.dispatchEvent(new Event("bookmarkedited"));
    }

    // Set the associated bookmark_tag_list_widget.
    //
    // Bookmark buttons and the tag list widget both manipulate and can create bookmarks.  Telling
    // us about an active bookmark_tag_list_widget lets us prevent collisions.
    set bookmark_tag_list_widget(value)
    {
        this._bookmark_tag_list_widget = value;
    }

    refresh_internal({ media_id, media_info })
    {
        // If this is a local image, we won't have a bookmark count, so set local-image
        // to remove our padding for it.  We can get media_id before media_info.
        let is_local =  helpers.is_media_id_local(media_id);
        helpers.set_class(this.container,  "has-like-count", !is_local);

        let { type } = helpers.parse_media_id(media_id);

        // Hide the private bookmark button for local IDs.
        if(this.bookmark_type == "private")
            this.container.closest(".button-container").hidden = is_local;

        let bookmarked = media_info?.bookmarkData != null;
        let private_bookmark = this.bookmark_type == "private";
        let is_our_bookmark_type = media_info?.bookmarkData?.private == private_bookmark;
        let will_delete = this.toggle_bookmark && is_our_bookmark_type;
        if(this.bookmark_type == "delete")
            is_our_bookmark_type = will_delete = bookmarked;

        // Set up the bookmark buttons.
        helpers.set_class(this.container,  "enabled",     media_info != null);
        helpers.set_class(this.container,  "bookmarked",  is_our_bookmark_type);
        helpers.set_class(this.container,  "will-delete", will_delete);
        
        // Set the tooltip.
        this.container.dataset.popup =
            media_info == null? "":
            !bookmarked && this.bookmark_type == "folder"? "Bookmark folder":
            !bookmarked && this.bookmark_type == "private"? "Bookmark privately":
            !bookmarked && this.bookmark_type == "public" && type == "folder"? "Bookmark folder":
            !bookmarked && this.bookmark_type == "public"? "Bookmark image":
            will_delete? "Remove bookmark":
            "Change bookmark to " + this.bookmark_type;
    }
    
    // Clicked one of the top-level bookmark buttons or the tag list.
    clicked_bookmark = async(e) =>
    {
        // See if this is a click on a bookmark button.
        let a = e.target.closest(".button-bookmark");
        if(a == null)
            return;

        e.preventDefault();
        e.stopPropagation();

        // If the tag list dropdown is open, make a list of tags selected in the tag list dropdown.
        // If it's closed, leave tag_list null so we don't modify the tag list.
        let tag_list = null;
        if(this._bookmark_tag_list_widget && this._bookmark_tag_list_widget.visible_recursively)
            tag_list = this._bookmark_tag_list_widget.selected_tags;

        // If we have a tag list dropdown, tell it to become inactive.  It'll continue to
        // display its contents, so they don't change during transitions, but it won't make
        // any further bookmark changes.  This prevents it from trying to create a bookmark
        // when it closes, since we're doing that already.
        if(this._bookmark_tag_list_widget)
            this._bookmark_tag_list_widget.deactivate();

        this._fire_onedited();

        let illust_data = await media_cache.get_media_info(this._media_id, { full: false });
        let private_bookmark = this.bookmark_type == "private";

        // If the image is bookmarked and a delete bookmark button or the same privacy button was clicked, remove the bookmark.
        let delete_bookmark = this.toggle_bookmark && illust_data.bookmarkData?.private == private_bookmark;
        if(this.bookmark_type == "delete")
            delete_bookmark = true;

        if(delete_bookmark)
        {
            if(!illust_data.bookmarkData)
                return;

            // Confirm removing bookmarks when on mobile.
            if(ppixiv.mobile)
            {
                let result = await (new ppixiv.confirm_prompt({ header: "Remove bookmark?" })).result;
                if(!result)
                    return;
            }

            let media_id = this._media_id;
            await actions.bookmark_remove(this._media_id);

            // If the current image changed while we were async, stop.
            if(media_id != this._media_id)
                return;
            
            // Hide the tag dropdown after unbookmarking, without saving any tags in the
            // dropdown (that would readd the bookmark).
            if(this.bookmark_tag_list_widget)
                this.bookmark_tag_list_widget.deactivate();

            this._fire_onedited();

            return;
        }

        // Add or edit the bookmark.
        await actions.bookmark_add(this._media_id, {
            private: private_bookmark,
            tags: tag_list,
        });
    }
}

// A trivial version of bookmark_button_widget that just displays if the image is bookmarked.
ppixiv.bookmark_button_display_widget = class extends ppixiv.illust_widget
{
    get needed_data() { return "partial"; }

    refresh_internal({ media_info })
    {
        let bookmarked = media_info?.bookmarkData != null;
        let private_bookmark = media_info?.bookmarkData?.private;

        helpers.set_class(this.container,  "enabled",     media_info != null);
        helpers.set_class(this.container,  "bookmarked",  bookmarked);
        helpers.set_class(this.container,  "public",      !private_bookmark);
    }
}

ppixiv.bookmark_count_widget = class extends ppixiv.illust_widget
{
    refresh_internal({ media_info })
    {
        this.container.textContent = media_info? media_info.bookmarkCount:"---";
    }
}

ppixiv.like_button_widget = class extends ppixiv.illust_widget
{
    get needed_data() { return "media_id"; }

    constructor(options)
    {
        super(options);

        this.container.addEventListener("click", this.clicked_like);
    }

    async refresh_internal({ media_id })
    {
        // Hide the like button for local IDs.
        this.container.closest(".button-container").hidden = helpers.is_media_id_local(media_id);

        let liked_recently = media_id != null? extra_cache.singleton().get_liked_recently(media_id):false;
        helpers.set_class(this.container, "liked", liked_recently);
        helpers.set_class(this.container, "enabled", !liked_recently);

        this.container.dataset.popup = this._media_id == null? "":
            liked_recently? "Already liked image":"Like image";
    }
    
    clicked_like = (e) =>
    {
        e.preventDefault();
        e.stopPropagation();

        if(this._media_id != null)
            actions.like_image(this._media_id);
    }
}

ppixiv.like_count_widget = class extends ppixiv.illust_widget
{
    async refresh_internal({ media_info })
    {
        this.container.textContent = media_info? media_info.likeCount:"---";
    }
}

// There seems to be no quick way to tell when scrollHeight or scrollWidth change on a
// scroller.  We have to watch for resizes on all children.
class ScrollDimensionsListener extends ppixiv.actor
{
    constructor({
        scroller,
        onchange = (listener) => { },
        ...options
    }={})
    {
        super({ ...options });

        this.onchange = onchange;

        // Create a MutationOBserver to watch for children being added or removed from the scroller.
        // We only need to look at immediate children.
        this._mutation_observer = new MutationObserver((mutations) => {
            for(let mutation of mutations)
            {
                for(let node of mutation.addedNodes)
                    this._resize_observer.observe(node);
                for(let node of mutation.removedNodes)
                    this._resize_observer.unobserve(node);
            }
        });
        this._mutation_observer.observe(scroller, { childList: true });
        this.shutdown_signal.signal.addEventListener("abort", () => this._mutation_observer.disconnect());

        // The ResizeObserver watches for size changes to children which could cause the scroll
        // size to change.
        this._resize_observer = new ResizeObserver(() => {
            this.onchange(this);
        });
        this.shutdown_signal.signal.addEventListener("abort", () => this._resize_observer.disconnect());

        // Add children that already exist to the ResizeObserver.
        for(let node of scroller.children)
            this._resize_observer.observe(node);
    }
}

// Watch for scrolls on a scroller, and call onchange when the user scrolls up or down.  This
// allows for an approximation of iOS's behavior of hiding navigation bars while scrolling down,
// then showing them if you scroll up.
//
// We can't mimic the behavior completely.  iOS hides navigation bars as you scroll, and then
// snaps to fully open or closed when you release the scroll.  There's no way to tell when a touch
// scroll ends, since scrolls cancel the touch and take it over completely.  No event is sent when
// the touch is released or when momentum scrolls settle.  Instead, we just watch for scrolling
// a minimum amount in the same direction,  This at least prevents the UI from appearing and disappearing
// too rapidly if the scroller is moved up and down quickly.
ppixiv.ScrollListener = class extends ppixiv.actor
{
    constructor({
        scroller,

        // The minimum amount of movement in the same direction before it's treated as
        // a direction change.
        threshold=50,

        // If not null, the threshold when dragging up.  This allows dragging down to
        // hide the UI to have a longer threshold than dragging up to display it.  If this
        // is null, threshold is used.
        threshold_up=10,

        // The initial value of scrolled_forwards.  This is also the value used if it's not
        // possible to scroll.
        default_value=false,

        // If set, we always consider the scroller dragged up until we're past the height of
        // this node.  This allows keeping sticky UI visible until we've scrolled far enough
        // that the content below it will fill its space when it's hidden.
        sticky_ui_node=null,

        // This is called when this.direction changes.
        onchange = (listener) => { },
        ...options
    })
    {
        super({ ...options });

        this._scroller = scroller;
        this._threshold = threshold;
        this._threshold_up = threshold_up ?? threshold;
        this._onchange = onchange;
        this._motion = 0;
        this._default_value = default_value;
        this._scrolled_forwards = false;
        this._sticky_ui_node = sticky_ui_node;
        this._scroller.addEventListener("scroll", () => this._refresh_after_scroll(), this._signal);

        // If we've been given a sticky UI node, refresh if its height changes.
        if(this._sticky_ui_node)
        {
            this._resize_observer = new ResizeObserver(() => {
                this._refresh_after_scroll();
            });
            this.shutdown_signal.signal.addEventListener("abort", () => this._resize_observer.disconnect());
            this._resize_observer.observe(this._sticky_ui_node);
        }

        // Use ScrollDimensionsListener to detect changes to scrollHeight.  This is needed so if
        // elements are removed and the scroller becomes no longer scrollable, we reset to the default
        // state (usually causing the UI to be visible).  Otherwise, it would be impossible to scroll
        // to show the UI if this happens.
        new ScrollDimensionsListener({
            scroller,
            parent: this,
            onchange: () => {
                console.log("changed");
                this._refresh_after_scroll({force: true});
            },
        });

        this.reset({call_onchange: false});
    }

    // Reset scrolled_forwards to the default and clear scroll history.  onchange will be
    // called if onchange is true.
    reset({call_onchange=true}={})
    {
        this._scrolled_forwards = this._default_value;
        this._last_scroll_y = this._scroller.scrollTop;
        this._last_scroll_height = this._scroller.scrollHeight;

        if(call_onchange)
            this._onchange(this);
    }

    // Return true if the most recent scroll was positive (down or right), or false if it was
    // negative.
    get scrolled_forwards()
    {
        return this._scrolled_forwards;
    }

    _refresh_after_scroll({force=false}={})
    {
        // If scrollHeight changed, content may have been added or removed to the scroller, so
        // we don't know if we've actually been scrolling up or down.  Ignore a single scroll
        // event after the scroller changes, so we don't treat a big content change as a scroll.
        if(!force && this._last_scroll_height != this._scroller.scrollHeight)
        {
            console.log("Ignoring scroll after scroller change");
            this._last_scroll_height = this._scroller.scrollHeight;
            return;
        }

        // If the scroller's scrollHeight changed since the last scroll, ignore 
        // Ignore scrolls past the edge, to avoid being confused by iOS's overflow scrolling.
        let new_scroll_top = helpers.clamp(this._scroller.scrollTop, 0, this._scroller.scrollHeight-this._scroller.offsetHeight);
        let delta = new_scroll_top - this._last_scroll_y;
        this._last_scroll_y = new_scroll_top;

        // If scrolling changed direction, reset motion.
        if(delta > 0 != this._motion > 0)
            this._motion = 0;
        this._motion += delta;

        // If we've moved far enough in either direction, set it as the scrolling direction.
        let scrolled_forwards = this._scrolled_forwards;
        if(this._motion < -this._threshold_up)
            scrolled_forwards = false;
        else if(Math.abs(this._motion) > this._threshold)
            scrolled_forwards = true;

        // If we're at the very top or very bottom, the user can't scroll any further to reach
        // the threshold, so force the direction to up or down.
        if(new_scroll_top == 0)
            scrolled_forwards = false;
        else if(new_scroll_top >= this._scroller.scrollHeight - 1)
            scrolled_forwards = true;

        if(this._sticky_ui_node)
        {
            if(new_scroll_top < this._sticky_ui_node.offsetHeight)
                scrolled_forwards = false;
        }

        // If it's not possible to scroll the scroller, always use the default.
        if(!this._can_scroll)
            scrolled_forwards = this._default_value;

        if(this._scrolled_forwards == scrolled_forwards)
            return;

        // Update the scroll direction.
        this._scrolled_forwards = scrolled_forwards;
        this._onchange(this);
    }

    // Return true if we think it's possible to move the scroller, ignoring overscroll.
    get _can_scroll()
    {
        return this._scroller.scrollHeight > this._scroller.offsetHeight;
    }
}
