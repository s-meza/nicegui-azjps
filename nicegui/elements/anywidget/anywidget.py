from __future__ import annotations

import importlib.util
import inspect
import os
from pathlib import Path
from typing import TYPE_CHECKING, Any, Tuple

from nicegui.events import GenericEventArguments
from ipywidgets.widgets.widget import _remove_buffers

from contextlib import contextmanager

from . import comm as aw_comm

from ... import optional_features
from ..mixins.value_element import ValueElement

if importlib.util.find_spec('anywidget'):
    optional_features.register('anywidget')
    if TYPE_CHECKING:
        import anywidget

# Current limitations
# -------------------
# Right now we are manually replacing the comm object in widgets.
# The expected way to work with comms is to import the module, and monkey patch create_comm and create_comm_manager.
#  a) I don't know if we should do this. Nothing else at the moment is using comms so technically it wouldn't interfere, but still.
#     It also means that nicegui *must* be imported before an AnyWidget is constructed.
#  b) The comms should be associated with a NiceGUI element in order to send messages to the frontend, and I'm not too sure how to do that via create_comm.
#     One way I see of doing this is create a comm manager (which should be a singleton) that has a method that allows us to register an element attached to a comm_id.
#     It should probably be in a weakref. But, at the moment, comms work fine so I haven't implemented this.
# The main reason for doing it this way is that, because they don't go through the manager, any registered targets don't run.

class AnyWidget(ValueElement,
                component='anywidget.js',
                esm={'nicegui-anywidget': 'dist'},
                dependencies=['widget.js', 'set-helper.js'],
                default_classes='nicegui-anywidget'):

    VALUE_PROP: str = 'traits'

    def __init__(self,
                 widget: anywidget.AnyWidget,
                 **kwargs: Any,
                 ) -> None:
        """Anywidget

        `anywidget <https://anywidget.dev/en/getting-started/>`_ is a library that allows you to
        embed arbitrary JavaScript widgets in a cross-frontend friendly manner.

        There are many publicly available examples of `anywidget` widgets
        in the `anywidget gallery <https://try.anywidget.dev/>`_, including
        `altair.JupyterChart <https://altair-viz.github.io/user_guide/interactions/jupyter_chart.html>`_,
        and `quak <https://github.com/manzt/quak>`_.

        Implementation: The `nicegui.anywidget` element takes an `Anywidget` and observes all `sync=True` traits
        of the widget, trigger JS updates when the traits change.
        Conversely, changes on the frontend will be synced back to the widget,
        using `ValueElement`'s handling to listen to changes on `traits`.

        :param widget: the `anywidget.AnyWidget` to wrap
        :param throttle: minimum time (in seconds) between widget updates to python (default: 0.0)
        """
        traits = self.get_traits(widget)
        super().__init__(value=traits, **kwargs)

        self._widget = widget

        # We need to replace the widget's comm object in order to communicate with it.
        # More info: https://ipywidgets.readthedocs.io/en/latest/examples/Widget%20Low%20Level.html
        # BaseComm.open() is called automatically, which sends messages to the frontend.
        self._widget.comm = aw_comm.create_comm(self, **_get_comm_kwargs(widget))

        self._should_send_update = True
        self._props['esm_content'], self._props['css_content'] = self.get_esm_css(widget)

        self._props['_debug'] = False  # set to True for console logging

        # Sent by model.send()
        self.on('anywidget:msg', self._widget_send)

        # Sent by model.save_changes()
        self.on('anywidget:save_changes', self._widget_save_changes)

    def _widget_send(self, content: GenericEventArguments) -> None:
        # TODO: Figure out what to do about the javascript callbacks
        _ret = self._widget._msg_callbacks(self._widget, *content.args)

    def _widget_save_changes(self, content: GenericEventArguments) -> None:
        """Called when model.save_changes() is called from the frontend."""
        # ipywidget.set_state handles extra keys in the dict fine.
        # It also uses a context manager to avoid sending events back.
        self._widget.set_state(content.args)

    def on_msg(self, callback, remove=False) -> None:
        """Register the callback with this instance's anywidget.
        Keep in mind that the callback will be called with the anywidget, not the NiceGUI element."""
        self._widget.on_msg(callback, remove=remove)

    @classmethod
    def get_esm_css(cls, widget_instance: anywidget.AnyWidget) -> Tuple[str, str]:
        """Extract the widget's ESM and CSS content, reading if they are `Path` objects"""
        # Get the ESM module content
        esm_content = getattr(widget_instance, '_esm')

        # Check if ESM content is a property function (sometimes the case in anywidget)
        if callable(esm_content) and not inspect.isclass(esm_content):
            esm_content = esm_content()

        # Get CSS content if available
        css_content = None
        if hasattr(widget_instance, '_css'):
            css_attr = getattr(widget_instance, '_css')
            if callable(css_attr) and not inspect.isclass(css_attr):
                css_content = css_attr()
            else:
                css_content = css_attr

        if isinstance(esm_content, str) and os.path.exists(esm_content):
            esm_content = Path(esm_content)
        if isinstance(css_content, str) and os.path.exists(css_content):
            css_content = Path(css_content)

        if isinstance(esm_content, os.PathLike):
            with open(esm_content, 'r') as f:
                esm_content = f.read()
        if isinstance(css_content, os.PathLike):
            with open(css_content, 'r') as f:
                css_content = f.read()
        return esm_content or '', css_content or ''

    @classmethod
    def get_traits(cls, widget_instance: anywidget.AnyWidget) -> dict[str, Any]:
        """Extract the widget's current state - only get traits marked with `sync=True`"""
        sync_traits = list(widget_instance.traits(sync=True))
        # get_state() will access the trait values and serialize to JSON if needed
        # https://ipywidgets.readthedocs.io/en/latest/_modules/ipywidgets/widgets/widget.html#Widget.get_state
        return widget_instance.get_state(key=sync_traits)

    def _handle_value_change(self, value: Any) -> None:
        """Update the widget's state when the value changes from frontend"""
        super()._handle_value_change(value)
        # TODO: currently this is iterating all traits and doing extra JSON serialization.
        # Ideally we would directly have the frontend tell us which traits have changed?
        current_traits = self.get_traits(self._widget)
        for key, value_ in value.items():
            if current_traits[key] != value_:
                setattr(self._widget, key, value_)
        if self._send_update_on_value_change:
            self.run_method('update_traits')

def _get_comm_kwargs(widget: anywidget.AnyWidget) -> dict:
    """
    Calculates keyword arguments to pass to the comm constructor.

    ipywidgets uses the global comm module functions,
    so this is a manual copy of the widget.open() function.
    """

    # This code is based off of ipywidgets.widgets.widget.Widget.open()
    # https://github.com/jupyter-widgets/ipywidgets/blob/72b939704a6caaef044550a8097388cf934521b4/python/ipywidgets/ipywidgets/widgets/widget.py
    # ipywidget's license is reproduced in LICENSE_JUPYTER.

    state, buffer_paths, buffers = _remove_buffers(widget.get_state())
    return {
        'target_name': 'jupyter.widget',
        'data': {'state': state, 'buffer_paths': buffer_paths},
        'buffers': buffers,
        # See here for version information 
        # https://github.com/jupyter-widgets/ipywidgets/blob/main/packages/schema/messages.md
        'metadata': {'version': "2.1.0"}
    }
