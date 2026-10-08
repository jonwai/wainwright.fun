// The hosted tickets handlers, unchanged. The build (and the tests, through tsx) resolve its
// kid-routes and budget-routes imports to ./shims.
import "./env.js";
export { tryHandleTaskRoute } from "../../infra/lambda/task-routes.js";
