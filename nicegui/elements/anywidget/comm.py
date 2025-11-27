"""Comm implementation for anywidget elements."""

import comm
from nicegui.element import Element

def create_comm(element: Element):
    return Comm(element)

class Comm(comm.BaseComm):
    element: Element

    def __init__(self, element: Element):
        self.element = element

        # super's init tries to call self.publish_msg so set element before
        super().__init__()

    def publish_msg(self, msg_type, data=None, metadata=None, buffers=None, **keys):
        self.element.run_method('publish_msg', {
            'msg_type': msg_type,
            'data': data,
            'buffers': buffers,
        })
