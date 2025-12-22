import { load_widget, load_css } from "widget";
import { cleanObject } from "../../static/utils/json.js";
import { set as set_helper } from "set-helper";

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
 * @property {string|null} comm_id Null until updated by the server
 */
class Comm {
  /**
   * Create a new Comm instance.
   * @param {Object} model
   * @param {(eventType: string, ...args: any[]) => void} emit_to_py E.g. this.$emit
   */
  constructor(model, emit_to_py) {
    this.model = model;
    this.emit_to_py = emit_to_py;
    this.comm_id = null;
  }

  recv_msg({msg_type, content: { data, comm_id }, metadata, buffers }) {

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
        // TODO: Store target name, buffer paths, buffers, metadata
        break;
      case "comm_msg":
        switch (data.method) {
          case "update":
            this.model.set_state(data.state);
            break;
          case "echo_update":
            // In jupyter this is meant to send back the state in case there are multiple front ends.
            break;
          case "request_state":
            this.send_msg('update', { state: this.attributes });
            break;
          case "custom":
            this.model.emit('msg:custom', data, buffers);
            break;
        }
        break;
      default:
        console.warn('Unknown message type:', msg_type, ' for ', {msg_type, data, metadata, buffers, comm_id});
        break;
    }
  }

  send_msg(method, content, buffers) {
    this.emit_to_py('anywidget:msg', {
      msg_type: 'comm_msg',
      content: {
        comm_id: this.comm_id,
        data: { method, ...content },
      },
      buffers: buffers || [],
    });
  }
}

/**
 * Implement AFM: https://anywidget.dev/en/afm/
 * References:
 * - Marimo AFM impl:
 * https://github.com/marimo-team/marimo/blob/7f3023ff0caef22b2bf4c1b5a18ad1899bd40fa3/frontend/src/plugins/impl/anywidget/AnyWidgetPlugin.tsx#L161-L267
 * Marimo's license is reproduced in LICENSE_MARIMO.
 * @param {function} on_ready Callback when the widget is ready to render (i.e. state is set)
 * @param {function} emit_to_py Send a message to the python backend
 * @returns An AFM object
 */
function createModel(on_ready, emit_to_py, traits) {
  const model = {
    /**
     * Should be true if model.set is triggering callbacks
     * @type {boolean}
     */
    _changing: false,
    /**
     * Changes that have been made, should reset when uploaded to the backend
     * @type {Object<string, any>}
     */
    changed: {},

    /** @type {Comm} */
    _comm: new Comm(null, emit_to_py),

    attributes: null, // Will wait for 'update' message instead.
    callbacks: {},
    get(key) {
      return cleanObject(this.attributes[key]);
    },

    set(key, value) {
      return set_helper(this, key, value);
    },

    set_state(state) {
      // Initial server state.
      if (this.attributes === null) {
        this.attributes = { ...state };
        on_ready(this);
        return;
      }

      this.set(state);
    },

    /** Upload changes to python */
    save_changes() {
      if (this.attributes === null) {
        throw new Error("NiceGUI-Anywidget: save_changes was called before widget was ready (was comm opened?)");
      }

      if (Object.keys(this.changed).length === 0) {
        return;
      }

      // Propagate the change back to python backend;
      // currently serializing all traits instead of just the changed ones
      // (ideally would do this to reduce communication overhead)
      // Could use this.changed to send just a diff.
      // This should NOT run any model.on("change:") callbacks on the frontend.
      this._comm.send_msg('update', { state: this.attributes });

      this.changed = {}
    },
    on(event, callback) {
      if (!this.callbacks[event]) this.callbacks[event] = [];
      this.callbacks[event].push(callback);
    },
    off(event, callback) {
      if (!event) this.callbacks = {};
      else if (!callback) this.callbacks[event] = [];
      else this.callbacks[event]?.delete(callback);
    },
    emit(event, ...values) {
      this.callbacks[event]?.forEach(cb => cb(...values));
      this.callbacks["all"]?.forEach(cb => cb(event));
    },

    send(content, callbacks, buffers) {
      if (callbacks) {
        // It's not clear what the callbacks argument is supposed to do.
        // Marimo seems to pass it to a Promise.then, jupyter takes in a whole object with different functions.
        //  - https://github.com/marimo-team/marimo/blob/7f3023ff0caef22b2bf4c1b5a18ad1899bd40fa3/frontend/src/plugins/impl/anywidget/AnyWidgetPlugin.tsx#L192
        //  - https://github.com/jupyter-widgets/ipywidgets/blob/b24fa6be5a289a23dd82eedcecbf6603ddbe2c0a/packages/base/src/widget.ts#L592
        console.warn('model.send() with callbacks is not supported in NiceGUI currently.');
      }

      this._comm.send_msg('custom', { content }, buffers);
    }
  };
  model._comm.model = model;

  // Serverside updates
  model.on("msg:update", (m, new_state) => {
    m.set_state(new_state);
  });

  return model;
}

export default {
  template: '<div class="nicegui-not-loaded">[NiceGUI-AnyWidget: Waiting for backend connection...]</div>',
  async mounted() {
    const emit_to_py = this.$emit;

    let on_widget_ready;

    // Don't render widget until we have a connection from the server.
    this._waitForComm = new Promise((resolve) => {
      // This should run immediately
      on_widget_ready = resolve;
    }).then(async (m) => {
      let mod;
      try {
        // Dynamically load esm_content as an ECMAScript module
         mod = await load_widget(this.esm_content, this.traits["_anywidget_id"]);
      } finally {
        // We lose the stacktrace if we catch the error.
        // This may happen if the esm has a syntax error, for example.
        this.$el.innerHTML = "[NiceGUI-AnyWidget: Error loading widget (check console for details)]";
        this.$el.classList.add("nicegui-error");
        this.$el.classList.remove("nicegui-not-loaded");
      }

      this.$el.innerHTML = "";
      this.$el.classList.remove("nicegui-not-loaded");

      this.cleanup_widget = await mod.initialize?.({ model: m });
      this.cleanup_view = await mod.render?.({ model: m, el: this.$el });

      this._waitForComm = null;
      on_widget_ready = null;
    });

    if (!on_widget_ready) {
      throw new Error("Promise executor did not run");
    }

    const model = createModel(on_widget_ready, emit_to_py, this.traits);
    this.model = model;

    load_css(this.css_content, this.traits["_anywidget_id"]);
  },
  methods: {
    update_trait(trait, value) {
      this.model.set(trait, value);
    },

    on_delete() {
      this.cleanup_widget?.();
      this.cleanup_view?.();
    },

    update_trait(trait, value) {
        this.model.set(trait, value);
    },

    publish_msg(msg) {
      this.model._comm.recv_msg(msg)
    }
  },
  props: {
    traits: Object,
    esm_content: String,
    css_content: String,
  },
};
