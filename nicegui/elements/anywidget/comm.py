"""Comm implementation for anywidget elements."""

import comm
from nicegui.element import Element
from uuid import UUID, uuid4

def create_comm(element: Element):
    return Comm(element)

# NOTE: Jupyter makes this a traitlets.config.LoggingConfigurable. Should we?
class Comm(comm.BaseComm):
    element: Element
    comm_id: UUID

    def __init__(self, element: Element):
        self.element = element
        self.comm_id = str(uuid4())

        # super's init tries to call self.publish_msg so set element before
        super().__init__()

    def publish_msg(self, msg_type, data=None, metadata=None, buffers=None, **keys):
        # Based on ipykernel https://github.com/ipython/ipykernel/blob/main/ipykernel/comm/comm.py#L18-L45
        data = data if data is not None else {}
        data.update(keys)

        metadata = metadata if metadata is not None else {}

        # NOTE: This doesnt 100% match the jupyter protocol, but I dont think it really needs to.
        # See: https://jupyter-client.readthedocs.io/en/latest/messaging.html#python-api
        self.element.run_method('publish_msg', {
            'msg_type': msg_type,
            'data': data,
            'metadata': metadata,
            'buffers': buffers,
            'comm_id': self.comm_id,
        })
