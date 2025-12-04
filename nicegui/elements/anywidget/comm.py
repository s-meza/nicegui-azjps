"""Comm implementation for anywidget elements."""

import comm
from nicegui.element import Element
from uuid import UUID, uuid4

def create_comm(element: Element, **kwargs):
    return Comm(element, **kwargs)

# NOTE: Jupyter makes this a traitlets.config.LoggingConfigurable. Should we?
class Comm(comm.BaseComm):
    element: Element
    comm_id: UUID

    def __init__(self, element: Element, **kwargs):
        # super's init tries to call self.publish_msg so we must set element beforehand.
        self.element = element

        if 'comm_id' not in kwargs:
            kwargs['comm_id'] = str(uuid4())

        super().__init__(**kwargs)

    def publish_msg(self, msg_type, data=None, metadata=None, buffers=None, **keys):
        # Based on ipykernel https://github.com/ipython/ipykernel/blob/main/ipykernel/comm/comm.py#L18-L45
        # ipykernel's license is reproduced in LICENSE_IPYTHON.
        data = data if data is not None else {}
        data.update(keys)

        metadata = metadata if metadata is not None else {}

        # NOTE: This doesnt 100% match the jupyter protocol, but I dont think it really needs to.
        # See: https://jupyter-client.readthedocs.io/en/latest/messaging.html#python-api
        # I will make it match this !!!!!!!!!!!!!!!!!!
        # See: https://github.com/jupyter-widgets/ipywidgets/blob/main/packages/schema/messages.md
        self.element.run_method('publish_msg', {
            'msg_type': msg_type,
            'data': data,
            'metadata': metadata,
            'buffers': buffers,
            'comm_id': self.comm_id,
        })
