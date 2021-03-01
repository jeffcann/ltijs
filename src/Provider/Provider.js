/* eslint-disable require-atomic-updates */
/* eslint-disable no-useless-escape */

/* Main class for the Provider functionalities */
// Dependencies
const url = require('fast-url-parser')
const provAuthDebug = require('debug')('provider:auth')
const provMainDebug = require('debug')('provider:main')
const provDynamicRegistrationDebug = require('debug')('provider:dynamicRegistrationService')

// Services
const Core = require('./Advantage/Services/Core')
const GradeService = require('./Advantage/Services/Grade')
const DeepLinkingService = require('./Advantage/Services/DeepLinking')
const NamesAndRolesService = require('./Advantage/Services/NamesAndRoles')
const DynamicRegistration = require('./Advantage/Services/DynamicRegistration')

// Classes
const Platform = require('./Advantage/Classes/Platform')
const Server = require('../GlobalUtils/Server')
const Keyset = require('../GlobalUtils/Keyset')

// Database
const Database = require('../GlobalUtils/Database')
const MongoDB = require('../GlobalUtils/MongoDB/MongoDB')

/**
 * @descripttion LTI Provider Class that implements the LTI 1.3 protocol and services.
 */
class Provider {
  // Pre-initiated variables
  #loginRoute = '/login'

  #appRoute = '/'

  #keysetRoute = '/keys'

  #dynRegRoute = '/register'

  #whitelistedRoutes = []

  #ENCRYPTIONKEY

  #devMode = false
  #ltiaas = false
  #legacy = false

  #tokenMaxAge = 10

  #cookieOptions = {
    secure: false,
    httpOnly: true,
    signed: true
  }

  // Setup flag
  #setup = false

  #connectCallback = async (token, req, res, next) => { return next() }

  #deepLinkingCallback = async (token, req, res, next) => { return next() }

  #dynamicRegistrationCallback = async (req, res, next) => {
    try {
      if (!req.query.openid_configuration) return res.status(400).send({ status: 400, error: 'Bad Request', details: { message: 'Missing parameter: "openid_configuration".' } })
      const message = await this.DynamicRegistration.register(req.query.openid_configuration, req.query.registration_token)
      res.setHeader('Content-type', 'text/html')
      res.send(message)
    } catch (err) {
      provDynamicRegistrationDebug(err)
      if (err.message === 'PLATFORM_ALREADY_REGISTERED') return res.status(403).send({ status: 403, error: 'Forbidden', details: { message: 'Platform already registered.' } })
      return res.status(500).send({ status: 500, error: 'Internal Server Error', details: { message: err.message } })
    }
  }

  #invalidTokenCallback = async (req, res) => {
    return res.status(401).send(res.locals.err)
  }

  #unregisteredPlatformCallback = async (req, res) => {
    return res.status(400).send({ status: 400, error: 'Bad Request', details: { message: 'UNREGISTERED_PLATFORM' } })
  }

  #inactivePlatformCallback = async (req, res) => {
    return res.status(401).send({ status: 401, error: 'Unauthorized', details: { message: 'PLATFORM_NOT_ACTIVATED' } })
  }

  #server

  /**
     * @description Provider configuration method.
     * @param {String} encryptionkey - Secret used to sign cookies and encrypt other info.
     * @param {Object} database - Database configuration.
     * @param {String} database.url - Database Url (Ex: mongodb://localhost/applicationdb).
     * @param {Object} [database.plugin] - If set, must be the Database object of the desired database plugin.
     * @param {Boolean} [database.debug] - If set to true, enables mongoose debug mode.
     * @param {Object} [database.connection] - MongoDB database connection options (Ex: user, pass)
     * @param {String} [database.connection.user] - Database user for authentication if needed.
     * @param {String} [database.conenction.pass] - Database pass for authentication if needed.
     * @param {Object} [options] - Lti Provider options.
     * @param {String} [options.appRoute = '/'] - Lti Provider main route. If no option is set '/' is used.
     * @param {String} [options.loginRoute = '/login'] - Lti Provider login route. If no option is set '/login' is used.
     * @param {String} [options.keysetRoute = '/keys'] - Lti Provider public jwk keyset route. If no option is set '/keys' is used.
     * @param {String} [options.dynRegRoute = '/register'] - Dynamic registration route.
     * @param {Boolean} [options.https = false] - Set this as true in development if you are not using any web server to redirect to your tool (like Nginx) as https and are planning to configure ssl through Express.
     * @param {Object} [options.ssl] - SSL certificate and key if https is enabled.
     * @param {String} [options.ssl.key] - SSL key.
     * @param {String} [options.ssl.cert] - SSL certificate.
     * @param {String} [options.staticPath] - The path for the static files your application might serve (Ex: _dirname+"/public")
     * @param {Boolean} [options.cors = true] - If set to false, disables cors.
     * @param {Function} [options.serverAddon] - Allows the execution of a method inside of the server contructor. Can be used to register middlewares.
     * @param {Object} [options.cookies] - Cookie configuration. Allows you to configure, sameSite and secure parameters.
     * @param {Boolean} [options.cookies.secure = false] - Cookie secure parameter. If true, only allows cookies to be passed over https.
     * @param {String} [options.cookies.sameSite = 'Lax'] - Cookie sameSite parameter. If cookies are going to be set across domains, set this parameter to 'None'.
     * @param {String} [options.cookies.domain] - Cookie domain parameter. This parameter can be used to specify a domain so that the cookies set by Ltijs can be shared between subdomains.
     * @param {Boolean} [options.devMode = false] - If true, does not require state and session cookies to be present (If present, they are still validated). This allows ltijs to work on development environments where cookies cannot be set. THIS SHOULD NOT BE USED IN A PRODUCTION ENVIRONMENT.
     * @param {Number} [options.tokenMaxAge = 10] - Sets the idToken max age allowed in seconds. Defaults to 10 seconds. If false, disables max age validation.
     * @param {Object} [options.dynReg] - Setup for the Dynamic Registration Service.
     * @param {String} [options.dynReg.url] - Tool Provider main URL. (Ex: 'https://tool.example.com')
     * @param {String} [options.dynReg.name] - Tool Provider name. (Ex: 'Tool Provider')
     * @param {String} [options.dynReg.logo] - Tool Provider logo. (Ex: 'https://client.example.org/logo.png')
     * @param {String} [options.dynReg.description] - Tool Provider description. (Ex: 'Tool description')
     * @param {Array<String>} [options.dynReg.redirectUris] - Additional redirect URIs. (Ex: ['https://tool.example.com/launch'])
     * @param {Object} [options.dynReg.customParameters] - Custom parameters object. (Ex: { key: 'value' })
     * @param {Boolean} [options.dynReg.autoActivate = false] - Platform auto activation flag. If true, every Platform registered dynamically is immediately activated. Defaults to false.
     */
  setup (encryptionkey, database, options) {
    if (this.#setup) throw new Error('PROVIDER_ALREADY_SETUP')
    if (options && options.https && (!options.ssl || !options.ssl.key || !options.ssl.cert)) throw new Error('MISSING_SSL_KEY_CERTIFICATE')
    if (!encryptionkey) throw new Error('MISSING_ENCRYPTION_KEY')
    if (!database) throw new Error('MISSING_DATABASE_CONFIGURATION')
    if (options && options.dynReg && (!options.dynReg.url || !options.dynReg.name)) throw new Error('MISSING_DYNREG_CONFIGURATION')

    if (options && (options.appRoute || options.appUrl)) this.#appRoute = options.appRoute || options.appUrl
    if (options && (options.loginRoute || options.loginUrl)) this.#loginRoute = options.loginRoute || options.loginUrl
    if (options && (options.keysetRoute || options.keysetUrl)) this.#keysetRoute = options.keysetRoute || options.keysetUrl
    if (options && options.dynRegRoute) this.#dynRegRoute = options.dynRegRoute

    if (options && options.devMode === true) this.#devMode = true
    if (options && options.ltiaas === true) this.#ltiaas = true
    if (options && options.legacy === true) this.#legacy = true
    if (options && options.tokenMaxAge !== undefined) this.#tokenMaxAge = options.tokenMaxAge

    // Cookie options
    if (options && options.cookies) {
      if (options.cookies.secure === true) this.#cookieOptions.secure = true
      if (options.cookies.sameSite) this.#cookieOptions.sameSite = options.cookies.sameSite
      if (options.cookies.domain) this.#cookieOptions.domain = options.cookies.domain
    }

    this.#ENCRYPTIONKEY = encryptionkey

    // Setup Databse
    let connector
    if (!database.plugin) connector = new MongoDB(database)
    else connector = database.plugin
    /**
     * @description Database object.
     */
    this.Database = Database
    this.Database.setup(this.#ENCRYPTIONKEY, connector, { type: 'PROVIDER', legacy: this.#legacy })

    // Setting up Server
    this.#server = new Server(options ? options.https : false, options ? options.ssl : false, this.#ENCRYPTIONKEY, options ? options.cors : true, options ? options.serverAddon : false)

    /**
     * @description Express server object.
     */
    this.app = this.#server.app

    /**
     * @description Grading service.
     */
    this.Grade = GradeService

    /**
     * @description Deep Linking service.
     */
    this.DeepLinking = DeepLinkingService

    /**
     * @description Names and Roles service.
     */
    this.NamesAndRoles = NamesAndRolesService

    if (options && options.dynReg) {
      const routes = {
        appRoute: this.#appRoute,
        loginRoute: this.#loginRoute,
        keysetRoute: this.#keysetRoute
      }
      /**
       * @description Dynamic Registration service.
       */
      this.DynamicRegistration = new DynamicRegistration(options.dynReg, routes)
    }

    if (options && options.staticPath) this.#server.setStaticPath(options.staticPath)

    /**
     * @description Main authentication middleware
     */
    this.app.use(async (req, res, next) => {
      provMainDebug('Receiving request at path: ' + req.baseUrl + req.path)
      // Ckeck if request is attempting to initiate oidc login flow or access reserved routes
      if (req.path === this.#loginRoute || req.path === this.#keysetRoute || req.path === this.#dynRegRoute) return next()
      try {
        // Retrieving ltik token
        const ltik = req.token
        // Retrieving cookies
        const cookies = req.signedCookies
        provMainDebug('Cookies received: ')
        provMainDebug(cookies)

        if (!ltik) {
          provMainDebug('Access Ltik not found')
          const state = req.body.state
          let savedQueries = false
          if (state) {
            provAuthDebug('Received state: ' + state)
            provAuthDebug('Cleaning state cookie')
            res.clearCookie('state' + state, this.#cookieOptions)
            savedQueries = await Database.get('state', { state: state })
            if (savedQueries) Database.delete('state', { state: state })
          }
          const idtoken = req.body.id_token
          if (!idtoken) throw new Error('NO_LTIK_OR_IDTOKEN_FOUND')
          provMainDebug('Received idtoken for validation')
          // Retrieving validation cookie
          const stateValue = cookies['state' + state]
          const validationParameters = {
            state: state,
            stateValue: stateValue,
            maxAge: this.#tokenMaxAge,
            devMode: this.#devMode,
            encryptionkey: this.#ENCRYPTIONKEY,
            path: req.path
          }
          // Validating launch
          const launch = await Core.launch(idtoken, validationParameters)

          if (this.#ltiaas) {
            // Appending query parameters
            res.locals.query = {}
            if (savedQueries) {
              for (const [key, value] of Object.entries(savedQueries[0].query)) {
                req.query[key] = value
                res.locals.query[key] = value
              }
            }
            // Creating local variables
            res.locals.context = launch.context
            res.locals.token = launch.token
            res.locals.token.platformContext = launch.context
            res.locals.ltik = launch.ltik
            provMainDebug('Forwarding request to next handler')
            return next()
          }

          // Creates platform session cookie
          res.cookie(launch.platformCode, launch.token.user, this.#cookieOptions)
          // Appending query parameters
          const query = new URLSearchParams(req.query)
          if (savedQueries) {
            for (const [key, value] of Object.entries(savedQueries[0].query)) {
              query.append(key, value)
            }
          }
          query.append('ltik', launch.ltik)
          const urlSearchParams = query.toString()
          provMainDebug('Redirecting to endpoint with ltik')
          return res.redirect(req.baseUrl + req.path + '?' + urlSearchParams)
        }

        provMainDebug('Access Ltik found')
        const validationParameters = {
          cookies: cookies,
          devMode: this.#devMode,
          ltiaas: this.#ltiaas,
          encryptionkey: this.#ENCRYPTIONKEY
        }
        const idToken = await Core.access(ltik, validationParameters)
        // Creating local variables
        res.locals.context = idToken.platformContext
        res.locals.token = idToken
        res.locals.ltik = ltik
        provMainDebug('Passing request to next handler')
        return next()
      } catch (err) {
        // Checking for whitelisted route
        if (await this.isWhitelisted({ path: req.path, method: req.method })) {
          provAuthDebug('Accessing as whitelisted route')
          return next()
        }
        provAuthDebug('Error during request validation: ', err)
        provAuthDebug('Request body: ', req.body)
        provAuthDebug('Request query: ', req.query)

        // Creating error obejct
        res.locals.err = {
          status: 401,
          error: 'Unauthorized',
          details: {
            description: 'Error validating ltik or IdToken',
            message: err.message,
            bodyReceived: req.body,
            queryReceived: req.query
          }
        }
        provAuthDebug('Passing request to invalid token handler')
        return this.#invalidTokenCallback(req, res, next)
      }
    })

    this.app.all(this.#loginRoute, async (req, res) => {
      const params = { ...req.query, ...req.body }
      if (!params.iss || !params.login_hint || !params.target_link_uri) return res.status(400).send({ status: 400, error: 'Bad Request', details: { message: 'MISSING_LOGIN_PARAMETERS' } })
      try {
        provMainDebug('Receiving a login request from: ' + params.iss)
        let platform = false
        if (params.client_id) platform = await Platform.getPlatform(params.iss, params.client_id)
        else {
          const platforms = await Platform.getPlatform(params.iss)
          if (platforms.length > 0) platform = platforms[0]
        }

        if (!platform) {
          provMainDebug('Unregistered platform attempting connection: ' + params.iss)
          return this.#unregisteredPlatformCallback(req, res)
        }

        const platformActive = await platform.platformActive()
        if (!platformActive) {
          provMainDebug('Inactive platform attempting connection: ' + params.iss)
          return this.#inactivePlatformCallback(req, res)
        }

        // Creating login request
        const login = await Core.login(platform, params)
        // Setting up validation info
        const cookieOptions = JSON.parse(JSON.stringify(this.#cookieOptions))
        cookieOptions.maxAge = 60 * 1000 // Adding max age to state cookie = 1min
        res.cookie('state' + login.state, params.iss, cookieOptions)
        // Redirect to authentication endpoint
        return res.redirect(login.target)
      } catch (err) {
        provMainDebug(err)
        return res.status(500).send({ status: 500, error: 'Internal Server Error', details: { message: err.message } })
      }
    })

    this.app.get(this.#keysetRoute, async (req, res, next) => {
      try {
        const keyset = await Keyset.build()
        return res.status(200).send(keyset)
      } catch (err) {
        provMainDebug(err)
        return res.status(500).send({ status: 500, error: 'Internal Server Error', details: { message: err.message } })
      }
    })

    this.app.all(this.#dynRegRoute, async (req, res, next) => {
      if (this.DynamicRegistration) return this.#dynamicRegistrationCallback(req, res, next)
      return res.status(403).send({ status: 403, error: 'Forbidden', details: { message: 'Dynamic registration is disabled.' } })
    })

    this.app.all(this.#appRoute, async (req, res, next) => {
      if (res.locals.context && res.locals.context.messageType === 'LtiDeepLinkingRequest') return this.#deepLinkingCallback(res.locals.token, req, res, next)
      return this.#connectCallback(res.locals.token, req, res, next)
    })

    this.#setup = true
    return this
  }

  /**
     * @description Starts listening to a given port for LTI requests and opens connection to the database.
     * @param {Object} [options] - Deployment options.
     * @param {Number} [options.port] - Deployment port. 3000 by default.
     * @param {Boolean} [options.silent] - If true, disables initial startup message.
     * @param {Boolean} [options.serverless] - If true, Ltijs does not start an Express server instance. This allows usage as a middleware and with services like AWS. Ignores 'port' parameter.
     * @returns {Promise<true>}
     */
  async deploy (options) {
    if (!this.#setup) throw new Error('PROVIDER_NOT_SETUP')
    provMainDebug('Attempting to connect to database')
    try {
      await Database.connect()

      const conf = {
        port: 3000,
        silent: false
      }

      if (options && options.port) conf.port = options.port
      if (options && options.silent) conf.silent = options.silent
      // Starts server on given port

      if (options && options.serverless) console.log('Ltijs started in serverless mode...')
      else {
        await this.#server.listen(conf.port)
        provMainDebug('Ltijs started listening on port: ', conf.port)

        // Startup message
        const message = 'LTI Provider is listening on port ' + conf.port + '!\n\n LTI provider config: \n >App Route: ' + this.#appRoute + '\n >Initiate Login Route: ' + this.#loginRoute + '\n >Keyset Route: ' + this.#keysetRoute + '\n >Dynamic Registration Route: ' + this.#dynRegRoute

        if (!conf.silent) {
          console.log('  _   _______ _____      _  _____\n' +
                      ' | | |__   __|_   _|    | |/ ____|\n' +
                      ' | |    | |    | |      | | (___  \n' +
                      ' | |    | |    | |  _   | |\\___ \\ \n' +
                      ' | |____| |   _| |_| |__| |____) |\n' +
                      ' |______|_|  |_____|\\____/|_____/ \n\n', message)
        }
      }
      if (this.#devMode && !conf.silent) console.log('\nStarting in Dev Mode, state validation and session cookies will not be required. THIS SHOULD NOT BE USED IN A PRODUCTION ENVIRONMENT!')

      // Sets up gracefull shutdown
      process.on('SIGINT', async () => {
        await this.close(options)
        process.exit()
      })

      return true
    } catch (err) {
      console.log('Error during deployment: ', err)
      await this.close(options)
      process.exit()
    }
  }

  /**
   * @description Closes connection to database and stops server.
   * @param {Object} [options] - Deployment options.
   * @param {Boolean} [options.silent] - If true, disables messages.
   * @returns {Promise<true>}
   */
  async close (options) {
    if (!options || options.silent !== true) console.log('\nClosing server...')
    await this.#server.close()
    if (!options || options.silent !== true) console.log('Closing connection to the database...')
    await Database.close()
    if (!options || options.silent !== true) console.log('Shutdown complete.')
    return true
  }

  /**
     * @description Sets the callback function called whenever there's a sucessfull lti 1.3 launch, exposing a "token" object containing the idtoken information.
     * @param {Function} connectCallback - Callback function called everytime a platform sucessfully launches to the provider.
     * @example .onConnect((token, request, response)=>{response.send('OK')})
     * @returns {true}
     */
  onConnect (connectCallback) {
    /* istanbul ignore next */
    if (!connectCallback) throw new Error('MISSING_CALLBACK')
    this.#connectCallback = connectCallback
    return true
  }

  /**
   * @description Sets the callback function called whenever there's a sucessfull deep linking launch, exposing a "token" object containing the idtoken information.
   * @param {Function} deepLinkingCallback - Callback function called everytime a platform sucessfully launches a deep linking request.
   * @example .onDeepLinking((token, request, response)=>{response.send('OK')})
   * @returns {true}
   */
  onDeepLinking (deepLinkingCallback) {
    if (!deepLinkingCallback) throw new Error('MISSING_CALLBACK')
    this.#deepLinkingCallback = deepLinkingCallback
    return true
  }

  /**
   * @description Sets the callback function called whenever there's a sucessfull dynamic registration request, allowing the registration flow to be customized.
   * @param {Function} dynamicRegistrationCallback - Callback function called everytime the LTI Provider receives a dynamic registration request.
   */
  onDynamicRegistration (dynamicRegistrationCallback) {
    if (!dynamicRegistrationCallback) throw new Error('MISSING_CALLBACK')
    this.#dynamicRegistrationCallback = dynamicRegistrationCallback
    return true
  }

  /**
   * @description Sets the callback function called when the token received fails to be validated.
   * @param {Function} invalidTokenCallback - Callback method.
   * @example .onInvalidToken((request, response)=>{response.send('Invalid token')})
   * @returns {true}
   */
  onInvalidToken (invalidTokenCallback) {
    if (!invalidTokenCallback) throw new Error('MISSING_CALLBACK')
    this.#invalidTokenCallback = invalidTokenCallback
    return true
  }

  /**
   * @description Sets the callback function called when the Platform attempting to login is not registered.
   * @param {Function} unregisteredPlatformCallback - Callback method.
   * @example .onUnregisteredPlatform((request, response)=>{response.send('Unregistered Platform')})
   * @returns {true}
   */
  onUnregisteredPlatform (unregisteredPlatformCallback) {
    if (!unregisteredPlatformCallback) throw new Error('MISSING_CALLBACK')
    this.#unregisteredPlatformCallback = unregisteredPlatformCallback
    return true
  }

  /**
   * @description Sets the callback function called when the Platform attempting to login is not activated.
   * @param {Function} inactivePlatformCallback - Callback method.
   * @example .onInactivePlatform((request, response)=>{response.send('Platform not activated')})
   * @returns {true}
   */
  onInactivePlatform (inactivePlatformCallback) {
    if (!inactivePlatformCallback) throw new Error('MISSING_CALLBACK')
    this.#inactivePlatformCallback = inactivePlatformCallback
    return true
  }

  /**
   * @description Gets the main application route that will receive the final decoded Idtoken at the end of a successful launch.
   * @returns {String}
   */
  appRoute () {
    return this.#appRoute
  }

  /**
   * @description Gets the login route responsible for dealing with the OIDC login flow.
   * @returns {String}
   */
  loginRoute () {
    return this.#loginRoute
  }

  /**
     * @description Gets the keyset route that will be used to retrieve a public jwk keyset.
     * @returns {String}
     */
  keysetRoute () {
    return this.#keysetRoute
  }

  /**
   * @description Gets the dynamic registration route that will be used to register platforms dynamically.
   * @returns {String}
   */
  dynRegRoute () {
    return this.#dynRegRoute
  }

  /**
   * @description Whitelists routes to bypass the Ltijs authentication protocol. If validation fails, these routes are still accessed but aren't given an idToken.
   * @param {String} routes - Routes to be whitelisted
   */
  whitelist (...routes) {
    if (!routes) return this.#whitelistedRoutes
    const formattedRoutes = []
    for (const route of routes) {
      const isObject = (!(route instanceof RegExp) && route === Object(route))
      if (isObject) {
        if (!route.route || !route.method) throw new Error('WRONG_FORMAT. Details: Expects string ("/route") or object ({ route: "/route", method: "POST" })')
        formattedRoutes.push({ route: route.route, method: route.method.toUpperCase() })
      } else formattedRoutes.push({ route: route, method: 'ALL' })
    }
    this.#whitelistedRoutes = [
      ...this.#whitelistedRoutes,
      ...formattedRoutes
    ]

    return this.#whitelistedRoutes
  }

  /**
   * Checks if a route is whitelisted.
   * @param {Object} route - Route object
   * @param {String} route.path - Route pach.
   * @param {String} route.method - HTTP Method.
   */
  async isWhitelisted (route) {
    if (!route || !route.path || !route.method) throw new Error('MISSING_ARGUMENT')
    if (this.#whitelistedRoutes.find(r => {
      if ((r.route instanceof RegExp && r.route.test(route.path)) || r.route === route.path) return r.method === 'ALL' || r.method === route.method.toUpperCase()
      return false
    })) return true
    return false
  }

  /**
   * @description Redirects to a new location. Passes Ltik if present.
   * @param {Object} res - Express response object.
   * @param {String} path - Redirect path.
   * @param {Object} [options] - Redirection options.
   * @param {Boolean} [options.newResource = false] - If true, changes the path variable on the context token.
   * @param {Object} [options.query] - Query parameters that will be added to the URL.
   * @example lti.redirect(response, '/path', { newResource: true })
   */
  async redirect (res, path, options) {
    if (!res || !path) throw new Error('MISSING_ARGUMENT')
    if (!res.locals.token) return res.redirect(path) // If no token is present, just redirects
    provMainDebug('Redirecting to: ', path)
    const token = res.locals.token
    const pathParts = url.parse(path)
    const additionalQueries = (options && options.query) ? options.query : {}

    // Updates path variable if this is a new resource
    if ((options && (options.newResource || options.isNewResource))) {
      provMainDebug('Changing context token path to: ' + path)
      await Database.modify('contexttoken', { contextId: token.platformContext.contextId, user: res.locals.token.user }, { path: path })
    }

    // Formatting path with queries
    const params = new URLSearchParams(pathParts.search)
    const queries = {}
    for (const [key, value] of params) { queries[key] = value }

    // Fixing fast-url-parser bug where port gets assigned to pathname if there's no path
    const portMatch = pathParts.pathname.match(/:[0-9]*/)
    if (portMatch) {
      pathParts.port = portMatch[0].split(':')[1]
      pathParts.pathname = pathParts.pathname.split(portMatch[0]).join('')
    }
    const formattedPath = url.format({
      protocol: pathParts.protocol,
      hostname: pathParts.hostname,
      pathname: pathParts.pathname,
      port: pathParts.port,
      auth: pathParts.auth,
      hash: pathParts.hash,
      query: {
        ...queries,
        ...additionalQueries,
        ltik: res.locals.ltik
      }
    })

    // Redirects to path with queries
    return res.redirect(formattedPath)
  }

  // Platform methods
  /**
   * @description Registers a platform.
   * @param {Object} platform
   * @param {String} platform.url - Platform url.
   * @param {String} platform.name - Platform nickname.
   * @param {String} platform.clientId - Client Id generated by the platform.
   * @param {String} platform.authenticationEndpoint - Authentication endpoint that the tool will use to authenticate within the platform.
   * @param {String} platform.accesstokenEndpoint - Access token endpoint that the tool will use to get an access token for the platform.
   * @param {Object} platform.authConfig - Authentication method and key for verifying messages from the platform. {method: "RSA_KEY", key:"PUBLIC KEY..."}
   * @param {String} platform.authConfig.method - Method of authorization "RSA_KEY" or "JWK_KEY" or "JWK_SET".
   * @param {String} platform.authConfig.key - Either the RSA public key provided by the platform, or the JWK key, or the JWK keyset address.
   * @returns {Promise<Platform>}
   */
  async registerPlatform (platform) {
    return Platform.registerPlatform(platform)
  }

  /**
   * @description Gets a platform.
   * @param {String} url - Platform url.
   * @param {String} clientId - Platform generated Client ID.
   * @returns {Promise<Platform | false>}
   */
  async getPlatform (url, clientId) {
    return Platform.getPlatform(url, clientId)
  }

  /**
   * @description Gets a platform by the Id.
   * @param {String} platformId - Platform Id.
   * @returns {Promise<Platform | false>}
   */
  async getPlatformById (platformId) {
    return Platform.getPlatformById(platformId)
  }

  /**
   * @description Updates a platform by the Id.
   * @param {String} platformId - Platform Id.
   * @param {Object} platformInfo - Update Information.
   * @param {String} platformInfo.url - Platform url.
   * @param {String} platformInfo.clientId - Platform clientId.
   * @param {String} platformInfo.name - Platform nickname.
   * @param {String} platformInfo.authenticationEndpoint - Authentication endpoint that the tool will use to authenticate within the platform.
   * @param {String} platformInfo.accesstokenEndpoint - Access token endpoint that the tool will use to get an access token for the platform.
   * @param {object} platformInfo.authConfig - Authentication method and key for verifying messages from the platform. {method: "RSA_KEY", key:"PUBLIC KEY..."}
   * @param {String} platformInfo.authConfig.method - Method of authorization "RSA_KEY" or "JWK_KEY" or "JWK_SET".
   * @param {String} platformInfo.authConfig.key - Either the RSA public key provided by the platform, or the JWK key, or the JWK keyset address.
   * @returns {Promise<Platform | false>}
   */
  async updatePlatformById (platformId, platformInfo) {
    return Platform.updatePlatformById(platformId, platformInfo)
  }

  /**
   * @description Deletes a platform.
   * @param {string} url - Platform url.
   * @param {String} clientId - Tool clientId.
   * @returns {Promise<true>}
   */
  async deletePlatform (url, clientId) {
    return Platform.deletePlatform(url, clientId)
  }

  /**
   * @description Deletes a platform by the Id.
   * @param {string} platformId - Platform Id.
   * @returns {Promise<true>}
   */
  async deletePlatformById (platformId) {
    return Platform.deletePlatformById(platformId)
  }

  /**
   * @description Gets all platforms.
   * @returns {Promise<Array<Platform>>}
   */
  async getAllPlatforms () {
    return Platform.getAllPlatforms()
  }
}

module.exports = new Provider()
