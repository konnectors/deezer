// Force sentry DSN into environment variables
// In the future, will be set by the stack
process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://3cfc427c2f18404da8db2ff632c29e83:bcc57d150cb7407983e78d995825a058@sentry.cozycloud.cc/72'

const {
  BaseKonnector,
  requestFactory,
  log,
  errors,
  scrape,
  saveBills,
  hydrateAndFilter,
  addData
} = require('cozy-konnector-libs')
const request = requestFactory({
  // debug: true,
  cheerio: false,
  json: false,
  jar: true
})
const cheerio = require('cheerio')
const moment = require('moment')

const baseUrl = 'https://www.deezer.com'
const PLAYLIST_DOCTYPE = 'io.cozy.deezer.playlists'

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  log('info', 'Parsing bills')
  const $ = await fetchBillsPage()
  const bills = parseBills($)

  log('info', 'Saving data to Cozy')
  await saveBills(bills, fields.folderPath, {
    identifiers: ['deezer'],
    contentType: 'application/pdf'
  })

  const playlists = await fetchPlayLists()

  const playlistsToSave = await hydrateAndFilter(playlists, PLAYLIST_DOCTYPE, {
    keys: ['id']
  })

  await addData(playlistsToSave, PLAYLIST_DOCTYPE)
}

async function authenticate(mail, password) {
  const result = await request.post(`${baseUrl}/ajax/action.php`, {
    form: {
      type: 'login',
      mail,
      password
    }
  })

  if (result.trim().indexOf('success') === -1) {
    throw new Error(errors.LOGIN_FAILED)
  }
}

async function fetchBillsPage() {
  const html = await request(`${baseUrl}/account/subscription`)
  return cheerio.load(html)
}

function parseBills($) {
  const bills = scrape(
    $,
    {
      title: '.payment-history-title',
      amount: {
        sel: '.payment-history-price',
        parse: normalizePrice
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
      filename: `${moment(bill.date).format('YYYY-MM-DD')}_deezer.pdf`,
      vendor: 'Deezer',
      metadata: {
        importDate: new Date(),
        version: 1
      }
    }
  })

  return bills
}

function normalizePrice(price) {
  return parseFloat(
    price
      .replace('€', '')
      .replace(',', '.')
      .trim()
  )
}

async function fetchPlayLists() {
  // first fetch the api token
  const userData = await request(
    `${baseUrl}/ajax/gw-light.php?method=deezer.getUserData&input=3&api_version=1.0&api_token=`
  )
  const api_token = userData.results.checkForm

  // then get the playlists ids from the user menu
  const userMenu = await request(
    `${baseUrl}/ajax/gw-light.php?method=deezer.userMenu&input=3&api_version=1.0&api_token=${api_token}`
  )

  log('info', 'Fetching playlists details')
  const playlists = []
  for (const playlist of userMenu.results.PLAYLISTS.data) {
    log('info', playlist.TITLE)
    const details = await fetchPlayListDetails(playlist, api_token)
    if (details) playlists.push(details)
  }

  return playlists
}

async function fetchPlayListDetails(playlist, api_token) {
  const content = await request.post(
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