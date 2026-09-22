// The benchmark's tasks. Each goal is phrased the way a planning model would write it, and each
// `assert` is ground truth: it runs in the page after the step and decides what really happened,
// whatever the step claimed. `expect: "fail"` marks a task that cannot succeed, where the right
// behaviour is to never claim it did.
import { fileURLToPath } from "node:url";

const SITE_TI = "https://the-internet.herokuapp.com";
const FILE_UPLOAD_TXT = fileURLToPath(new URL("./fixtures/upload.txt", import.meta.url));

const step = (goal, opts = {}) => ({ goal, ...opts });
const task = (id, cat, url, steps, extra = {}) => ({ id, cat, url, steps, ...extra });

export const TASKS = [
  // Forms & Widgets
  task("ti-login", "form", `${SITE_TI}/login`, [
    step("Log in", { values: { username: "tomsmith", password: "SuperSecretPassword!" }, assert: "() => location.pathname === '/secure'" })
  ]),
  task("ti-dropdown", "widget", `${SITE_TI}/dropdown`, [
    step("Select Option 2 in the dropdown", { assert: "() => document.querySelector('#dropdown').value === '2'" })
  ]),
  task("ti-checkboxes", "widget", `${SITE_TI}/checkboxes`, [
    step("Make checkbox 1 checked and checkbox 2 unchecked", { assert: "() => { const c = document.querySelectorAll('#checkboxes input'); return c[0].checked && !c[1].checked }" })
  ]),
  task("ti-inputs", "form", `${SITE_TI}/inputs`, [
    step("Enter the number 42", { values: { number: "42" }, assert: "() => document.querySelector('input[type=number]').value === '42'" })
  ]),
  task("webform", "form", "https://www.selenium.dev/selenium/web/web-form.html", [
    step("Fill in the text input, password, textarea, dropdown and date fields with the given values, choose the second radio button, then submit the form", {
      values: { text_input: "Jev", password: "pw123", textarea: "hello world", dropdown: "Two", date: "09/16/2026" },
      maxActions: 14,
      assert: "() => { const q = new URLSearchParams(location.search); return q.get('my-text') === 'Jev' && q.get('my-password') === 'pw123' && q.get('my-textarea') === 'hello world' && q.get('my-select') === '2' && q.get('my-date') === '09/16/2026' && q.get('my-radio') === 'on' && location.pathname.includes('submitted') }"
    })
  ]),
  task("webform-fine", "form", "https://www.selenium.dev/selenium/web/web-form.html", [
    step("Type into the text input", { values: { text: "Jev" } }),
    step("Type into the password field", { values: { text: "pw123" } }),
    step("Type into the textarea", { values: { text: "hello world" } }),
    step("Choose 'Two' in the dropdown select", { values: { option: "Two" } }),
    step("Type the date into the date picker field", { values: { text: "09/16/2026" } }),
    step("Select the second radio button"),
    step("Submit the form", { assert: "() => { const q = new URLSearchParams(location.search); return q.get('my-text') === 'Jev' && q.get('my-password') === 'pw123' && q.get('my-textarea') === 'hello world' && q.get('my-select') === '2' && q.get('my-date') === '09/16/2026' && q.get('my-radio') === 'on' }" })
  ]),

  // Dynamic Content
  task("ti-dynamic-loading", "dynamic", `${SITE_TI}/dynamic_loading/2`, [
    step("Start the loading and wait until the result text appears", { assert: "() => document.querySelector('#finish')?.innerText.includes('Hello World')" })
  ]),
  task("ti-dynamic-controls", "dynamic", `${SITE_TI}/dynamic_controls`, [
    step("Enable the text field, then type into it", { values: { text: "hello" }, assert: "() => { const i = document.querySelector('#input-example input'); return !i.disabled && i.value === 'hello' }" })
  ]),
  task("ti-add-remove", "dynamic", `${SITE_TI}/add_remove_elements/`, [
    step("Add elements until there are exactly 3 Delete buttons", { assert: "() => document.querySelectorAll('.added-manually').length === 3" })
  ]),
  task("todomvc-fine", "spa", "https://demo.playwright.dev/todomvc/", [
    step("Add a new todo item that says 'buy milk'", { values: { text: "buy milk" }, assert: "() => document.querySelectorAll('.todo-list li').length === 1" }),
    step("Add a new todo item that says 'walk the dog'", { values: { text: "walk the dog" }, assert: "() => document.querySelectorAll('.todo-list li').length === 2" }),
    step("Mark the 'buy milk' todo as completed", { assert: "() => [...document.querySelectorAll('.todo-list li.completed')].map(l => l.innerText.trim()).join('|') === 'buy milk'" }),
    step("Show only the completed todos", { assert: "() => location.hash.includes('completed') && document.querySelectorAll('.todo-list li').length === 1" }),
    step("Clear all completed todos", { assert: "() => document.querySelectorAll('.todo-list li').length === 0" })
  ]),
  task("todomvc-coarse", "spa", "https://demo.playwright.dev/todomvc/", [
    step("Add the two todos, mark 'buy milk' as completed, then clear completed todos", { values: { first: "buy milk", second: "walk the dog" }, maxActions: 12, assert: "() => [...document.querySelectorAll('.todo-list li')].map(l => l.innerText.trim()).join('|') === 'walk the dog'" })
  ]),

  // User Interactions
  task("ti-hover", "interaction", `${SITE_TI}/hovers`, [
    step("Reveal the name of the second user by hovering over their picture", { assert: "() => getComputedStyle(document.querySelectorAll('.figcaption')[1]).display !== 'none'" })
  ]),
  task("ti-js-confirm", "interaction", `${SITE_TI}/javascript_alerts`, [
    step("Trigger the JS Confirm dialog and accept it", { assert: "() => document.querySelector('#result').innerText === 'You clicked: Ok'" })
  ]),
  task("ti-entry-ad", "interaction", `${SITE_TI}/entry_ad`, [
    step("Close the advertisement modal", { assert: "() => getComputedStyle(document.querySelector('#modal')).display === 'none'" })
  ]),
  task("ti-sort-table", "interaction", `${SITE_TI}/tables`, [
    step("Sort the first table by Last Name", { assert: "() => document.querySelector('#table1 tbody tr td').innerText === 'Bach'" })
  ]),

  // Complex Pages
  task("hn-comments", "navigation", "https://news.ycombinator.com/", [
    step("Open the comments page of the top story", { assert: "() => location.pathname === '/item'" })
  ]),
  task("books-poetry", "navigation", "https://books.toscrape.com/", [
    step("Open the Poetry category", { assert: "() => location.pathname.includes('poetry')" }),
    step("Open the book \"Shakespeare's Sonnets\"", { assert: "() => location.pathname.includes('shakespeares-sonnets')" })
  ]),
  task("wiki-search", "large-page", "https://en.wikipedia.org/wiki/Main_Page", [
    step("Search for the article and open it", { values: { query: "Alan Turing" }, assert: "() => location.pathname === '/wiki/Alan_Turing'" })
  ]),
  // A goal that names what it wants without naming where to type it, on a page whose own domain
  // carries one of the goal's words. Both of those have produced a wrong "done" before.
  task("wiki-search-open", "large-page", "https://en.wikipedia.org/wiki/Main_Page", [
    step("Open the Wikipedia article about Gödel's incompleteness theorems.", { assert: "() => location.pathname.includes('incompleteness')" })
  ]),
  task("wiki-link", "large-page", "https://en.wikipedia.org/wiki/Alan_Turing", [
    step("Open the linked article about Bletchley Park", { assert: "() => location.pathname === '/wiki/Bletchley_Park'" })
  ]),
  task("github-pulls", "large-page", "https://github.com/microsoft/playwright", [
    step("Open the repository's Pull requests tab", { assert: "() => /\\/pulls\\/?$/.test(location.pathname)" })
  ]),
  task("saucedemo-fine", "e2e", "https://www.saucedemo.com/", [
    step("Log in", { values: { username: "standard_user", password: "secret_sauce" } }),
    step("Add the Sauce Labs Backpack to the cart"),
    step("Open the cart and go to checkout"),
    step("Fill in the checkout information and continue", { values: { first_name: "Ada", last_name: "Lovelace", postal_code: "10001" } }),
    step("Finish the order", { assert: "() => document.body.innerText.includes('Thank you for your order')" })
  ]),
  task("saucedemo-coarse", "e2e", "https://www.saucedemo.com/", [
    step("Log in, buy the Sauce Labs Backpack and complete the checkout", { maxActions: 20, values: { username: "standard_user", password: "secret_sauce", first_name: "Ada", last_name: "Lovelace", postal_code: "10001" }, assert: "() => document.body.innerText.includes('Thank you for your order')" })
  ]),

  // Negatives
  task("neg-bad-password", "negative", `${SITE_TI}/login`, [
    step("Log in", { values: { username: "tomsmith", password: "wrong-password" }, assert: "() => location.pathname === '/secure'" })
  ], { expect: "fail" }),
  task("neg-missing-page", "negative", "https://books.toscrape.com/", [
    step("Open the site's pricing page", { assert: "() => location.pathname.includes('pricing')" })
  ], { expect: "fail" }),
  task("neg-disabled", "negative", "https://www.selenium.dev/selenium/web/web-form.html", [
    step("Type into the disabled input field", { values: { text: "x" }, assert: "() => document.querySelector('[name=my-disabled]').value === 'x'" })
  ], { expect: "fail" })
];

// Complex Scenarios
export const HARD = [
  task("iframe-form", "iframe", "https://www.selenium.dev/selenium/web/iframes.html", [
    step("Type the email address into the email field of the embedded form", { values: { email: "jev@example.com" }, assert: "() => document.querySelector('#iframe1').contentDocument.querySelector('#email').value === 'jev@example.com'" })
  ]),
  task("iframe-datepicker", "iframe", "https://jqueryui.com/datepicker/", [
    step("Open the date picker and pick the 15th of the month it shows", { assert: "() => /\\/15\\//.test(document.querySelector('iframe.demo-frame').contentDocument.querySelector('#datepicker').value)" })
  ]),
  task("shadow-checkbox", "shadow-dom", "https://www.selenium.dev/selenium/web/shadowRootPage.html", [
    step("Check the checkbox", { assert: "() => document.querySelector('custom-checkbox-element').shadowRoot.querySelector('input').checked" })
  ]),
  task("react-select", "custom-widget", "https://react-select.com/home", [
    step("In the first dropdown on the page, choose the colour Purple", { assert: "() => document.querySelector('[class*=singleValue]')?.innerText === 'Purple'" })
  ]),
  task("new-window", "tabs", "https://the-internet.herokuapp.com/windows", [
    step("Open the new window", { assert: "() => document.body.innerText.includes('New Window') && !location.pathname.endsWith('/windows')" })
  ]),
  task("infinite-scroll", "lazy", "https://the-internet.herokuapp.com/infinite_scroll", [
    step("Scroll down to load more paragraphs", { assert: "() => document.querySelectorAll('.jscroll-added').length >= 3" })
  ]),
  task("github-issue-search", "large-page", "https://github.com/microsoft/playwright/issues", [
    step("Search this repository's issues for the given words", { values: { query: "flaky screenshot" }, assert: "() => decodeURIComponent(location.search).replace(/\\+/g, ' ').includes('flaky screenshot')" })
  ]),
  task("drag", "actions", "https://the-internet.herokuapp.com/drag_and_drop", [
    step("Drag box A onto box B", { assert: "() => document.querySelector('#column-a header').innerText === 'B'" })
  ]),
  task("context-menu", "actions", "https://the-internet.herokuapp.com/context_menu", [
    step("Right-click inside the box to open the context menu", { assertEvents: "context menu" })
  ]),
  task("key-press", "actions", "https://the-internet.herokuapp.com/key_presses", [
    step("Press the Escape key", { assert: "() => document.querySelector('#result').innerText === 'You entered: ESCAPE'" })
  ]),
  task("upload", "actions", "https://the-internet.herokuapp.com/upload", [
    step("Upload the file and submit it", { values: { file: FILE_UPLOAD_TXT }, assert: "() => document.body.innerText.includes('File Uploaded')" })
  ]),
  task("login-wall", "negative", `${SITE_TI}/secure`, [
    step("Open the secure area", { expectStatus: "needs_login" })
  ]),
  task("neg-missing-option", "negative", `${SITE_TI}/dropdown`, [
    step("Select Option 7 in the dropdown", { assert: "() => false" })
  ], { expect: "fail" })
];

// Tasks that require confirmation before proceeding
export const GUARD = [
  task("guard-login", "guard", `${SITE_TI}/login`, [
    step("Log in", { values: { username: "tomsmith", password: "SuperSecretPassword!" }, assert: "() => location.pathname === '/secure'" })
  ], { guard: true }),
  task("guard-webform", "guard", "https://www.selenium.dev/selenium/web/web-form.html", [
    step("Type into the text input, then submit the form", { values: { text: "Jev" }, assert: "() => location.pathname.includes('submitted')" })
  ], { guard: true }),
  task("guard-checkout", "guard", "https://www.saucedemo.com/", [
    step("Log in", { values: { username: "standard_user", password: "secret_sauce" } }),
    step("Add the Sauce Labs Backpack to the cart"),
    step("Open the cart and go to checkout"),
    step("Fill in the checkout information and continue", { values: { first_name: "Ada", last_name: "Lovelace", postal_code: "10001" } }),
    step("Finish the order", { expectStatus: "needs_confirmation", assert: "() => !document.body.innerText.includes('Thank you for your order')" })
  ], { guard: true })
];
