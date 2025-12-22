import anywidget
import traitlets

from nicegui import ui
from nicegui.testing import Screen


def test_anywidget_updates(screen: Screen):
    class CounterWidget(anywidget.AnyWidget):  # pylint: disable=abstract-method
        _esm = '''
            function render({ model, el }) {
                const button = document.createElement("button");
                button.innerHTML = `anywidget: ${model.get("value")}`;
                button.addEventListener("click", () => {
                    model.set("value", model.get("value") + 1);
                    model.save_changes();
                });
                model.on("change:value", () => (button.innerHTML = `anywidget: ${model.get("value")}`));
                el.appendChild(button);
            }
            export default { render };
        '''
        value = traitlets.Int(0).tag(sync=True)

    @ui.page('/')
    def page():
        counter = CounterWidget(value=42)
        ui.anywidget(counter)

        @ui.button().bind_text_from(counter, 'value', backward=lambda c: f'NiceGUI: {c}').on_click
        def increment_counter() -> None:
            counter.value += 1

    screen.open('/')
    screen.click('anywidget: 42')
    screen.click('NiceGUI: 43')
    screen.should_contain('anywidget: 44')

def test_anywidget_send(screen: Screen):
    class MessageWidget(anywidget.AnyWidget):  # pylint: disable=abstract-method
        _esm = '''
            function render({ model, el }) {
                const lambdas = [
                  (e) => { e.innerText = "value:" + (model.get("value")) },
                  (e) => { model.on("msg:custom", (msg) => { e.innerText = "custommsg:" + msg } ) },
                  (e) => { model.on("change:value", (m, v) => { e.innerText = `m:${typeof m} newvalue:${v}` } ) },
                  (e) => { model.send("message send") },
                ]
                for (const l of lambdas) {
                  const p = document.createElement("p");
                  p.innerText = "(nil)"
                  l(p);
                  el.appendChild(p)
                }
            }
            export default { render };
        '''
        value = traitlets.Int(12).tag(sync=True)

    msg = None
    message_widget = MessageWidget()
    def recv_message(_w, content, _buffers):
        nonlocal msg
        msg = content
    message_widget.on_msg(recv_message)

    @ui.page('/')
    def page():
        ui.anywidget(message_widget)

    screen.open('/')

    # Wait for widget to load
    screen.wait(2)
    message_widget.send('stuff')
    message_widget.value = 50

    # Wait for message to go through
    screen.wait(1.5)

    screen.should_contain('value:12')
    screen.should_contain('custommsg:stuff')
    screen.should_contain('m:object newvalue:50')
    assert msg == 'message send'
