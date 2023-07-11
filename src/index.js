import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
const log = Minilog('ContentScript')
Minilog.enable('deezerCCC')

const defaultSourceAccountIdentifier = 'deezer'
const baseUrl = 'https://deezer.com'
const loginUrl = 'https://deezer.com/fr/login'
const accountUrl = `${baseUrl}/account/`

class TemplateContentScript extends ContentScript {
  async navigateToLoginForm() {
    this.log('info', '🤖 navigateToLoginForm')
    await this.goto(loginUrl)
    await Promise.race([
      this.waitForElementInWorker('#login_password'),
      this.waitForElementInWorker('.player-bottom')
    ])
  }

  async ensureAuthenticated({ account }) {
    await this.bridge.call(
      'setUserAgent',
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0'
    )
    // This eventListener is supposed to get the user's credential but it is commented because it leads to a crash of the konnector due to missing element.
    // this.bridge.addEventListener('workerEvent', this.onWorkerEvent.bind(this))
    this.log('info', '🤖 ensureAuthenticated')
    if (!account) {
      await this.ensureNotAuthenticated()
    }
    await this.navigateToLoginForm()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      this.log('info', 'Not authenticated')
      await this.showLoginFormAndWaitForAuthentication()
    }
    this.unblockWorkerInteractions()
    return true
  }

  async ensureNotAuthenticated() {
    this.log('info', '🤖 ensureNotAuthenticated')
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      return true
    }
    await this.navigateToLoginForm()
    await this.clickAndWait(
      '.topbar-profile',
      'a[class="account-link is-main"]'
    )
    await this.clickAndWait(
      'a[class="account-link is-main"]',
      'a[href="/login"]'
    )
    return true
  }

  async getUserDataFromWebsite() {
    this.log('info', '🤖 getUserDataFromWebsite')
    await this.goto(accountUrl)
    await this.waitForElementInWorker('.chakra-input')
    await this.runInWorker('getIdentity')
    this.log('info', `${this.store.userIdentity.email}`)
    await this.saveIdentity(this.store.userIdentity)
    if (this.store.userIdentity.email) {
      return {
        sourceAccountIdentifier: this.store.userIdentity.email
      }
    } else {
      throw new Error('No user data identifier. The konnector should be fixed')
    }
  }

  async fetch(context) {
    this.log('info', '🤖 fetch')
    // The only way we found to reach the bills page without opening a new window in the AA is to make a goto to this url
    await this.goto(
      'https://www.deezer.com/pay_login?referer=&pay=1&redirect_type=page&redirect_link=%2Faccount%2Fsubscription%3Fuser_just_logged%3D1'
    )
    await this.waitForElementInWorker('[pause]')
  }

  // onWorkerEvent(event, payload) {
  //   if (event === 'loginSubmit') {
  //     this.log('info', 'received loginSubmit, blocking user interactions')
  //     this.blockWorkerInteractions()
  //   } else if (event === 'loginError') {
  //     this.log(
  //       'info',
  //       'received loginError, unblocking user interactions: ' + payload?.msg
  //     )
  //     this.unblockWorkerInteractions()
  //   }
  // }

  // onWorkerReady() {
  //   const button = document.querySelector('#login_form_submit')
  //   if (button) {
  //     button.addEventListener('click', () =>
  //       this.bridge.emit('workerEvent', 'loginSubmit')
  //     )
  //   }
  //   const error = document.querySelector('#login_error')

  //   const isDisplayed = error.getAttribute('style').match('none') ? false : true
  //   if (isDisplayed) {
  //     this.bridge.emit('workerEvent', 'loginError', {
  //       msg: error.textContent.trim()
  //     })
  //   }
  // }

  async checkAuthenticated() {
    return Boolean(document.querySelector('.player-bottom'))
  }

  async showLoginFormAndWaitForAuthentication() {
    log.debug('showLoginFormAndWaitForAuthentication start')
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({
      method: 'waitForAuthenticated'
    })
    await this.setWorkerState({ visible: false })
  }

  async getIdentity() {
    // There is nothing to scrape on Deezer website, the only thing available and useful for an identity is the email
    const email = document.querySelectorAll('.chakra-input')[0].value
    const userIdentity = {
      email
    }
    await this.sendToPilot({ userIdentity })
  }
}

const connector = new TemplateContentScript()
connector
  .init({ additionalExposedMethodsNames: ['getIdentity'] })
  .catch(err => {
    log.warn(err)
  })
