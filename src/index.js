// Force sentry DSN into environment variables
// In the future, will be set by the stack
process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://3cfc427c2f18404da8db2ff632c29e83:bcc57d150cb7407983e78d995825a058@sentry.cozycloud.cc/72'

const {
  CookieKonnector,
  solveCaptcha,
  log,
  errors,
  scrape,
  hydrateAndFilter,
  addData,
  cozyClient,
  utils
} = require('cozy-konnector-libs')
const cheerio = require('cheerio')
const moment = require('moment')

const baseUrl = 'https://www.deezer.com'
const PLAYLIST_DOCTYPE = 'io.cozy.deezer.playlists'

class DeezerKonnector extends CookieKonnector {
  async fetch(fields) {
    if (!(await this.testSession())) {
      log('info', 'Authenticating ...')
      await this.authenticate(fields.login, fields.password)
      log('info', 'Successfully logged in')
    }
    log('info', 'Parsing bills')
    const $ = await this.fetchBillsPage()
    let bills = this.parseBills($)
    bills = await this.filterBillsWithoutPDF(bills, fields.folderPath)

    log('info', 'Saving data to Cozy')
    await this.saveBills(bills, fields.folderPath, {
      identifiers: ['deezer'],
      contentType: 'text/html',
      sourceAccount: this.accountId,
      sourceAccountIdentifier: fields.login,
      fileIdAttributes: ['date', 'amount']
    })

    const playlists = await this.fetchPlayLists()
    const playlistsToSave = await hydrateAndFilter(
      playlists,
      PLAYLIST_DOCTYPE,
      {
        keys: ['id']
      }
    )

    await addData(playlistsToSave, PLAYLIST_DOCTYPE)
  }

  async testSession() {
    log('info', 'Test the validity of old session')
    try {
      await this.request({
        url: 'https://www.deezer.com/fr/login',
        resolveWithFullResponse: true,
        followRedirect: false,
        followAllRedirects: false
      })
      // If no error (302 to /fr/), login is invalid
      log('info', 'Session invalid')
      return false
    } catch (err) {
      if (err.statusCode === 302 && err.response.headers.location === '/fr/') {
        log('info', 'Session is valid')
        return true
      } else {
        log('info', 'Getting error during testing, Session invalid')
        return false
      }
    }
  }

  async authenticate(mail, password) {
    // Extracting sitekey for captcha
    const websiteURL = 'https://www.deezer.com/fr/login'
    const reqLogin = await this.request({
      url: 'https://www.deezer.com/fr/login'
    })
    const $login = cheerio.load(reqLogin)
    const captchaDiv = $login('div[class="recaptcha-wrapper"]').html()
    const websiteKey = captchaDiv.match(/"sitekey": "(.*)"/)[1]
    const captchaToken = await solveCaptcha({ websiteURL, websiteKey })

    // Initiate API UserData object, for checkFormLogin token
    const req1 = await this.request({
      url: `https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&input=3&api_version=1.0&api_token=&cid=`
    })

    const result = await this.request.post(`${baseUrl}/ajax/action.php`, {
      form: {
        type: 'login',
        mail,
        password,
        checkFormLogin: req1.results.checkFormLogin,
        reCaptchaToken: captchaToken
      }
    })

    if (result.trim().includes('success')) {
      return
    } else if (result.trim() === 'error') {
      throw new Error(errors.LOGIN_FAILED)
    } else {
      log('error', result)
      throw new Error(errors.VENDOR_DOWN)
    }
  }

  async fetchBillsPage() {
    const html = await this.request(`${baseUrl}/account/subscription`)
    return cheerio.load(html)
  }

  parseBills($) {
    const bills = scrape(
      $,
      {
        title: '.payment-history-title',
        amount: {
          sel: '.payment-history-price',
          parse: this.normalizePrice
        },
        currency: {
          sel: '.payment-history-price',
          parse: price => price.slice(-1)
        },
        date: {
          sel: '.payment-history-date',
          parse: date => moment(date, 'DD/MM/YYYY').toDate()
        },
        fileurl: {
          sel: 'a',
          attr: 'href'
        }
      },
      '.history-list > li:not(:nth-child(1))'
    ).map(bill => {
      return {
        ...bill,
        filename: `${moment(bill.date).format('YYYY-MM-DD')}_deezer.html`,
        requestOptions: {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:62.0) Gecko/20100101 Firefox/62.0'
          }
        },
        vendor: 'Deezer'
      }
    })

    return bills
  }

  async filterBillsWithoutPDF(bills, folderPath) {
    log('debug', `${bills.length} bills before filtering`)
    let filteredBills = bills
    const dir = await cozyClient.files.statByPath(folderPath)
    const oldFiles = await utils.queryAll('io.cozy.files', { dir_id: dir._id })
    for (const bill of bills) {
      // Evaluating old name by removing .html
      const pdfMatchingName = bill.filename.slice(0, -5) + '.pdf'
      for (const oldFile of oldFiles) {
        if (oldFile.name.match(pdfMatchingName)) {
          // Deleting element
          log('debug', `Removing ${bill.filename}, pdf present`)
          filteredBills.splice(filteredBills.indexOf(bill), 1)
        }
      }
    }
    log('debug', `${filteredBills.length} bills after filtering`)
    return filteredBills
  }

  normalizePrice(price) {
    return parseFloat(
      price
        .replace('€', '')
        .replace(',', '.')
        .trim()
    )
  }

  async fetchPlayLists() {
    // first fetch the api token
    const userData = await this.request(
      `${baseUrl}/ajax/gw-light.php?method=deezer.getUserData&input=3&api_version=1.0&api_token=`
    )
    const api_token = userData.results.checkForm

    // then get the playlists ids from the user menu
    const userMenu = await this.request(
      `${baseUrl}/ajax/gw-light.php?method=deezer.userMenu&input=3&api_version=1.0&api_token=${api_token}`
    )

    log('info', 'Fetching playlists details')
    const playlists = []
    for (const playlist of userMenu.results.PLAYLISTS.data) {
      log('info', playlist.TITLE)
      const details = await this.fetchPlayListDetails(playlist, api_token)
      if (details) playlists.push(details)
    }

    return playlists
  }

  async fetchPlayListDetails(playlist, api_token) {
    const content = await this.request.post(
      `${baseUrl}/ajax/gw-light.php?method=deezer.pagePlaylist&input=3&api_version=1.0&api_token=${api_token}`,
      {
        json: true,
        body: {
          playlist_id: playlist.PLAYLIST_ID,
          lang: 'en',
          nb: 1000000,
          start: 0,
          tab: 0,
          tags: true,
          header: true
        }
      }
    )

    if (!content.results) {
      log('warn', 'No songs')
      return false
    }

    return {
      id: playlist.PLAYLIST_ID,
      title: content.results.DATA.TITLE,
      description: content.results.DATA.DESCRIPTION,
      count: content.results.DATA.NB_SONG,
      songs: content.results.SONGS.data.map(song => ({
        id: song.SNG_ID,
        title: song.SNG_TITLE,
        artist: song.ART_NAME,
        duration: song.DURATION,
        album: {
          id: song.ALB_ID,
          title: song.ALB_TITLE
        }
      }))
    }
  }
}

const connector = new DeezerKonnector({
  // debug: true,
  cheerio: false,
  json: true,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:62.0) Gecko/20100101 Firefox/62.0'
  }
})

connector.run()
