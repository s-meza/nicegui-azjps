from __future__ import annotations

import importlib.util
import inspect
from pathlib import Path
from typing import TYPE_CHECKING, Any

# Importing this is not ideal. Maybe we could vendor it as well?
from anywidget._util import remove_buffers

from ... import helpers, optional_features
from ...events import GenericEventArguments
from ..mixins.value_element import ValueElement
from . import comm as aw_comm

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
#
# An immediate disadvantage of replacing the comm manually is that, because they don't go through the comm manager, any registered targets do not run.

class AnyWidget(ValueElement, component='anywidget.js', dependencies=['lib/widget.js', 'lib/set-helper.js'], esm={'nicegui-anywidget': 'dist'}):
    VALUE_PROP: str = 'traits'

    def __init__(self, widget: anywidget.AnyWidget, *, throttle: float = 0) -> None:
        """AnyWidget

        `anywidget <https://anywidget.dev/en/getting-started/>`_ is a library that allows you to
        embed arbitrary JavaScript widgets in a cross-frontend friendly manner.

        There are many publicly available examples of anywidget widgets
        in the `anywidget gallery <https://try.anywidget.dev/>`_, including
        `altair.JupyterChart <https://altair-viz.github.io/user_guide/interactions/jupyter_chart.html>`_,
        and `quak <https://github.com/manzt/quak>`_.

        Implementation: The ``nicegui.anywidget`` element takes an ``AnyWidget`` and observes all ``sync=True`` traits
        of the widget, trigger JS updates when the traits change.
        Conversely, changes on the frontend will be synced back to the widget,
        using ``ValueElement``'s handling to listen to changes on ``traits``.

        *Added in version 3.5.0*

        :param widget: the ``anywidget.AnyWidget`` to wrap
        :param throttle: minimum time (in seconds) between widget updates to Python (default: 0.0)
        """
        self._widget = widget
        self._traits = widget.traits(sync=True)
        super().__init__(value=widget.get_state(self._traits), throttle=throttle)
        self._props['esm_content'] = _get_attribute(widget, '_esm')
        self._props['css_content'] = _get_attribute(widget, '_css')
        self._widget.observe(lambda change: self.run_method('update_trait', change['name'], change['new']), self._traits)

        # We need to replace the widget's comm object in order to communicate with it.
        # More info: https://ipywidgets.readthedocs.io/en/latest/examples/Widget%20Low%20Level.html
        # BaseComm.open() is called automatically, which sends messages to the frontend.
        self._widget.comm = aw_comm.create_comm(self, **_get_comm_kwargs(widget))

        # Sent by model.send()
        self.on('anywidget:msg', self._on_widget_msg)

        # Sent by model.save_changes()
        self.on('anywidget:save_changes', self._widget_save_changes)

    def _on_widget_msg(self, content: GenericEventArguments) -> None:
        """Called when comm.send_msg() is called from the frontend."""
        # pylint: disable=protected-access
        self._widget._handle_msg(content.args)

    def _widget_save_changes(self, content: GenericEventArguments) -> None:
        """Called when model.save_changes() is called from the frontend."""
        # ipywidget.set_state handles extra keys in the dict fine.
        # It also uses a context manager to avoid sending events back.
        self._widget.set_state(content.args)

    def on_msg(self, callback, remove=False) -> None:
        """Register the callback with this instance's anywidget.
        Keep in mind that the callback will be called with the AnyWidget, not the NiceGUI element."""
        self._widget.on_msg(callback, remove=remove)

    def _handle_delete(self) -> None:
        self.run_method('on_delete')
        super()._handle_delete()

    def _handle_value_change(self, value: Any) -> None:
        """Update the widget's state when the value changes from frontend"""
        super()._handle_value_change(value)
        state = self._widget.get_state(self._traits)
        for key, value_ in value.items():
            if state[key] != value_:
                setattr(self._widget, key, value_)


def _get_attribute(obj: object, name: str) -> str:
    """Extract the attribute's content, reading if it is a path to a file."""
    content = getattr(obj, name, '')
    if callable(content) and not inspect.isclass(content):  # content is a property function
        content = content()
    assert isinstance(content, (str, Path)), f'Attribute {name} is not a string or Path'
    if helpers.is_file(content):
        content = Path(content).read_text(encoding='utf8')
    assert isinstance(content, str), f'Attribute {name} is a Path but does not exist'
    return content

def _get_comm_kwargs(widget: anywidget.AnyWidget) -> dict:
    """
    Calculates keyword arguments to pass to the comm constructor.

    ipywidgets uses the global comm module functions,
    so this is a manual copy of the widget.open() function.
    """

    # This code is based off of ipywidgets.widgets.widget.Widget.open()
    # https://github.com/jupyter-widgets/ipywidgets/blob/72b939704a6caaef044550a8097388cf934521b4/python/ipywidgets/ipywidgets/widgets/widget.py
    # ipywidget's license is reproduced in LICENSE_JUPYTER.

    state, buffer_paths, buffers = remove_buffers(widget.get_state())
    return {
        'target_name': 'jupyter.widget',
        'data': {'state': state, 'buffer_paths': buffer_paths},
        'buffers': buffers,
        # See here for version information
        # https://github.com/jupyter-widgets/ipywidgets/blob/main/packages/schema/messages.md
        'metadata': {'version': '2.1.0'}
    }
