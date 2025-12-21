// This file contains a modified version of jupyter's backbone patch, which is itself a modified version of the set function from Backbone.js
// This has been changed to use JSDoc, and remove functionality not needed for anywidget.
// Jupyter's full license is reproduced in LICENSE_JUPYTER.

// (see
// https://github.com/jashkenas/backbone/blob/05fde9e201f7e2137796663081105cd6dad12a98/backbone.js#L460,
// with changes below marked with an EDIT comment). This file in Backbone has the following license.

//     (c) 2010-2015 Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors
//     Backbone may be freely distributed under the MIT license.
//     For all details and documentation:
//     http://backbonejs.org

// Backbone's full license is below (from https://github.com/jashkenas/backbone/blob/05fde9e201f7e2137796663081105cd6dad12a98/LICENSE)

/*
Copyright (c) 2010-2015 Jeremy Ashkenas, DocumentCloud

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
*/

import { isEqual, isObject } from 'nicegui-anywidget';

// Set a hash of model attributes on the object, firing `"change"`. This is
// the core primitive operation of a model, updating the data and notifying
// anyone who needs to know about the change in state. The heart of the beast.
// EDIT: Takes model as first argument instead of `this`.
/**
 * @param {string|{}} key
 * @param {any?} val
 * @return {any}
 */
export function set(model, key, val){
  if (key == null) {
    return this;
  }

  // Handle both `"key", value` and `{key: value}` -style arguments.
  /** @type {{[key: string]: any}} */
  let attrs
  if (isObject(key)) {
    attrs = key;
  } else {
    (attrs = {})[key] = val;
  }

  // Extract attributes and options.
  const changes = [];
  // EDIT: Rename to prevChanging
  const prevChanging = model._changing;
  model._changing = true;
  try {
    if (!prevChanging) {
      // EDIT: changed to use object spread instead of _.clone
      model._previousAttributes = { ...model.attributes };
      model.changed = {};
    }

    const current = model.attributes;
    const changed = model.changed;
    const prev = model._previousAttributes;

    // For each `set` attribute, update or delete the current value.
    for (const attr in attrs) {
      val = attrs[attr];
      if (!isEqual(current[attr], val)) {
        changes.push(attr);
      }
      if (!isEqual(prev[attr], val)) {
        changed[attr] = val;
      } else {
        delete changed[attr];
      }
      current[attr] = val;
    }

    // Update the `id`.
    // TODO: Do we need this?
    // model.id = model.get(model.idAttribute);

    // Trigger all relevant attribute changes.
    // EDIT: Removed silent check
    if (changes.length) {
      model._pending = true;
    }
    for (let i = 0; i < changes.length; i++) {
        model.emit('change:' + changes[i], model, current[changes[i]]);
    }

    // You might be wondering why there's a `while` loop here. Changes can
    // be recursively nested within `"change"` events.
    if (prevChanging) {
      return model;
    }
    while (model._pending) {
        model._pending = false;
        model.emit('change', model);
    }
  } finally {
    model._pending = false;
    model._changing = false;
  }
  return model;
}
