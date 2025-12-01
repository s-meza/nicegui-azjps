import { load_widget, load_css } from "widget";  // lib/anywidget/widget.js
import { convertDynamicProperties } from "../../static/utils/dynamic_properties.js";

/**
 * Communication layer for anywidget models.
 *
 * @class
 * @classdesc
 * Comm is responsible for handling messages between the frontend model and the Python backend
 * via the emit_to_py callback. Used for synchronizing widget state and sending/receiving
 * protocol messages.
 *
 * @property {Object} model
 * @property {(eventType: string, ...args: any[]) => void} emit_to_py E.g. this.$emit
 * @property {(...args: any[]) => void} log
 * @property {string|null} comm_id Null until updated by the server
 */
class Comm {
  /**
   * Create a new Comm instance.
   * @param {Object} model
   * @param {(eventType: string, ...args: any[]) => void} emit_to_py E.g. this.$emit
   * @param {null|(...args: any[]) => void} log
   */
  constructor(model, emit_to_py, log) {
    this.model = model;
    this.emit_to_py = emit_to_py;
    this.log = log || (()=>{});
    this.comm_id = null;
  }

  recv_msg({msg_type, data, metadata, buffers, comm_id}) {
    this.log(`[${this.comm_id||"?"}] Received message:`, {msg_type, data, metadata, buffers, comm_id});
    console.log(`[${this.comm_id||"?"}] Received message:`, {msg_type, data, metadata, buffers, comm_id});

    if (this.comm_id != null && this.comm_id !== comm_id) {
      return;
    }

    switch (msg_type) {
      case "comm_open":
        if (this.comm_id != null) {
          break;
        }
        this.comm_id = comm_id;
        this.model.set_state(data.state);
        // TODO: Set target name, buffer paths, buffers, metadata
        break;
      case "comm_msg":
        switch (data.method) {
          case "update":
            this.model.set_state(data.state);
            break;
          case "echo_update":
            // This seems to be an implementation detail from jupyter?
            // I think it just sends back the state in case there are multiple front ends.
            console.warn("Comm echo_update not implemented yet")
            break;
          case "custom":
            this.model.emit('msg:custom', data, buffers);
            console.warn("Comm custom not implemented yet")
            break;
        }
        // if method == update, do a model update from serverside.
        // if method == echo_update, figure out what that does.
        // if method == custom, run handlers.
        break;
      default:
        console.warn('Unknown message type:', msg_type, ' for ', {msg_type, data, metadata, buffers, comm_id});
        break;
    }
  }

  send_msg(msg) {
    // TODO: Is this correct?
    console.log('send_msg', msg);
    this.emit_to_py('anywidget:msg', msg);
  }
}

/**
 * Implement AFM: https://anywidget.dev/en/afm/
 * References:
 * - Marimo AFM impl:
 * https://github.com/marimo-team/marimo/blob/7f3023ff0caef22b2bf4c1b5a18ad1899bd40fa3/frontend/src/plugins/impl/anywidget/AnyWidgetPlugin.tsx#L161-L267
 * @param {function} on_ready Callback when the widget is ready to render (i.e. state is set)
 * @param {function} emit_to_py Send a message to the python backend
 * @param {function} log Logger
 * @returns An AFM object
 */
function createModel(on_ready, emit_to_py, log, traits) {
  const model = {
    /**
     * Whether the current change was triggered by a server update.
     * TODO: Is this necessary?
     */
    _changing_from_server: false,
    /**
     * Should be true if model.set is triggering callbacks
     * TODO: Jupyter seems to set this externally?
     * @type {boolean}
     */
    _changing: false,
    /**
     * Changes that have been made, should reset when uploaded to the backend
     * @type {Object<string, any>}
     */
    _changes: {},

    // TODO: We can also keep track of the state diff and the state diff which has been synced.
    //  See: https://github.com/jupyter-widgets/ipywidgets/blob/b24fa6be5a289a23dd82eedcecbf6603ddbe2c0a/packages/base/src/widget.ts#L445-L465
    //  See: https://github.com/jupyter-widgets/ipywidgets/blob/b24fa6be5a289a23dd82eedcecbf6603ddbe2c0a/packages/base/src/widget.ts#L632-L655

    /**
     * State prior to backend update.
     * https://github.com/jupyter-widgets/ipywidgets/blob/b24fa6be5a289a23dd82eedcecbf6603ddbe2c0a/packages/base/src/widget.ts#L424-L436
     * @type {Object<string, any>?}
     */
    _state_lock: null,

    /** @type {Comm} */
    _comm: new Comm(null, emit_to_py, log),

    attributes: null, // Will wait for update message instead.
    callbacks: {},
    get: function (key) {
      log('Getting value for', key, ':', this.attributes[key]);

      const value = this.attributes[key];
      try {
        // TODO: this should not be necessary but was running into some
        // JavaScript issues that haven't tried to figure out
        return JSON.parse(JSON.stringify(value));
      } catch (e) {
        // If value is not serializable, return null or a fallback render widget until we have a connection from the server.
        console.warn('NiceGUI-Anywidget: Value for key', key, 'is not JSON-serializable:', value);
        return null;
      }
    },

    set: function (key, value) {
      log('Setting value for', key, ':', value);

      this._changing = true;
      // TODO: Delegate to other function.
      // XXX: Good reference: https://github.com/jupyter-widgets/ipywidgets/blob/main/packages/base/src/backbone-patch.ts
      this.attributes[key] = value;
      this.emit('change:' + key, this, value); // TODO: state_lock stuff.

      this._changing = false;
    },

    set_state: function (state) {
      // Initial server state.
      if (this.attributes === null) {
        this.attributes = { ...state };
        on_ready(this);
        return;
      }

      log('Received updated state', state);
      this._changing_from_server = true;
      // TODO: Proper handling for server updates: don't send things back when save_changes is called.
      //       Jupyter seems to keep track of the diffs.
      // TODO: Proper handling for recursive updates.
      // TODO: Maybe send just a diff so it doesn't have to iterate over all attributes.
      //       Jupyter seems to use underscore.js (although someone on stackoverflow suggested lodash)

      for (const [key, value] of Object.entries(state)) {
        this.set(key, value);
      }

      this._changing_from_server = false;
    },

    /** Upload changes to python */
    save_changes: function () {
      log('Saving changes:', this.attributes);

      // Propagate the change back to python backend;
      // currently serializing all traits instead of just the changed ones
      // (ideally would do this to reduce communication overhead)
      emit_to_py('update:traits', { ...this.attributes });
    },
    on: function (event, callback) {
      log('Registering callback for event:', event);
      if (!this.callbacks[event]) {
        this.callbacks[event] = [];
      }
      this.callbacks[event].push(callback);
    },
    off: function (event, callback) {
      if (!event) {
        this.callbacks = {};
        return;
      }
      if (!callback) {
        this.callbacks[event] = [];
        return;
      }
      this.callbacks[event]?.delete(callback);
    },

    emit: function (event, ...values) {
      if (this.callbacks[event]) {
        this.callbacks[event].forEach(cb => cb(...values));
      }
    },

    send: function (content, callbacks, buffers) {
      if (callbacks) {
        // I genuinely don't know what the callbacks argument is supposed to do.
        // marimo seems to pass it to a Promise.then, but for jupyter it's a whole object
        // with a bunch of different functions.
        //  - https://github.com/marimo-team/marimo/blob/7f3023ff0caef22b2bf4c1b5a18ad1899bd40fa3/frontend/src/plugins/impl/anywidget/AnyWidgetPlugin.tsx#L192
        //  - https://github.com/jupyter-widgets/ipywidgets/blob/b24fa6be5a289a23dd82eedcecbf6603ddbe2c0a/packages/base/src/widget.ts#L592
        console.warn('model.send() callbacks are not supported in NiceGUI currently.');
        console.warn("If you know what they're for please let me know.");
      }

      emit_to_py('anywidget:send', content, buffers);
    }
  };
  model._comm.model = model;


  model.on("msg:update", (m, new_state) => {
    // Handle any server-side updates
    // TODO: Try and figure out a way to avoid infinite update loops.
    //       I dont know if anywidget does that.
    for (const [key, value] of Object.entries(new_state)) {
      if (m.attributes[key] !== value) {
        // TODO: These should be m.set() calls.
        m.set(key, value);
      }
    }
  });

  return model;
}

export default {
  template: "<div>Waiting for backend connection...</div>",
  mounted() {
    this.init_widget();
  },
  methods: {
    _log(...args) {
      if (this._debug) {
        console.log("NiceGUI-Anywidget", ...args);
      }
    },

    init_widget() {
      (async () => {
        const emit_to_py = this.$emit;
        const log = this._log;

        let on_widget_ready;

        // Don't render widget until we have a connection from the server.
        this._waitForComm = new Promise((resolve) => {
          on_widget_ready = resolve;
        }).then(async (m) => {
          // Dynamically load esm_content as an ECMAScript module
          const mod = await load_widget(this.esm_content, this.traits["_anywidget_id"]);

          this.$el.innerHTML = "";

          // TODO: cleanup_widget and cleanup_view should be called when the widget is destroyed
          this.cleanup_widget = await mod.initialize?.({ model: m });
          this.cleanup_view = await mod.render?.({ model: m, el: this.$el });

          this._waitForComm = null;
          on_widget_ready = null;
        });

        if (!on_widget_ready) {
          throw new Error("Promise executor did not run");
        }

        const model = createModel(on_widget_ready, emit_to_py, log, this.traits);
        this.model = model;
       // on_widget_ready(model)
      })();

      load_css(this.css_content, this.traits["_anywidget_id"]);

    },

    /**
     * Callback from Python traitlet backend change event
     * @param {Object} change
     * @param {string} change.trait
     * @param {any} change.new
     * @param {any} change.old
     */
    update_trait(change) {
      convertDynamicProperties(change, true);

      this._log('Updating trait:', change);

      if (change) {
        this.model._changing_from_server = true;
        this.model.set(change['trait'], change['new']);
        this.model._changing_from_server = false;
      }
    },

    update_traits() {
      // Currently no-op
      this._log('Updating traits:', this.traits, this.model.attributes);
    },
    handle_event(type, args) {
      // Currently unused
      this._log('handle_event', type, args);
    },
    publish_msg(msg) {
      this.model._comm.recv_msg(msg)
    }
  },
  props: {
    traits: Object,
    esm_content: String,
    css_content: String,
    _debug: Boolean,
  },
};
