import { Injectable, NgZone } from '@angular/core';
import { BarcodeScanner, BarcodeScannerOptions, BarcodeScanResult } from '@fttx/barcode-scanner';
import { FirebaseAnalytics } from '@ionic-native/firebase-analytics';
import { AlertController, Platform } from 'ionic-angular';
import { Observable, Subscription, Subscriber } from 'rxjs';
import { KeyboardInputComponent } from '../components/keyboard-input/keyboard-input';
import { OutputBlockModel } from '../models/output-block.model';
import { OutputProfileModel } from '../models/output-profile.model';
import { ScanModel } from '../models/scan.model';
import { SelectScanningModePage } from '../pages/scan-session/select-scanning-mode/select-scanning-mode';
import { Settings } from './settings';
import { Utils } from './utils';
import * as Supplant from 'supplant';
import { Config } from './config';
import { AlertInputOptions } from 'ionic-angular/components/alert/alert-options';

/**
 * The job of this class is to generate a ScanModel by talking with the native
 * barcode scanner plugin and/or by asking the user the required data to fill
 * the data of the selected OutputProfile.
 *
 * The only public method is scan
 */
@Injectable()
export class ScanProvider {
  public awaitingForBarcode: boolean;

  private pluginOptions: BarcodeScannerOptions

  // This parameter is different from SelectScanningModePage.SCAN_MODE_* but
  // it kinds of extends it.
  // The SCAN_MODE_* is more related to the UI, so what the user is able to
  // choose, while the acquisitionMode is how actually the barcode acquisition
  // is performed.
  // This separation is required in order to allow the mixed_continue when
  // there is a quantity parameter or when the native plugin doesn't support
  // the continue mode.
  public acqusitionMode: 'manual' | 'single' | 'mixed_continue' | 'continue' = 'manual';
  private barcodeFormats;
  private outputProfile: OutputProfileModel;
  private outputProfileIndex: number;
  private deviceName: string;
  private quantityType: string;
  private keyboardInput: KeyboardInputComponent;

  constructor(
    private alertCtrl: AlertController,
    private barcodeScanner: BarcodeScanner,
    private platform: Platform,
    private ngZone: NgZone,
    private firebaseAnalytics: FirebaseAnalytics,
    private settings: Settings,
  ) {
  }

  private lastObserver: Subscriber<ScanModel> = null;
  private _scanCallId: number = null; // used to prevent scan(), and thus again() calls overlaps

  /**
   * It returns an Observable that will output a ScanModel everytime the
   * current OutputProfile is completed.
   *
   * Whenever the scan process ends or is interrupted, it will send
   * an "complete" event
   *
   * @param scanMode SCAN_MODE_CONTINUE, SCAN_MODE_SINGLE or SCAN_MODE_MANUAL
   * @param outputProfileIndex by default there is only one OutputProfile
   * @param scanSession is required to inject the scanSession.name as variable
   * @param keyboardInput element for manual acquisition
   */
  scan(scanMode, outputProfileIndex, scanSession, keyboardInput: KeyboardInputComponent): Observable<ScanModel> {
    // prevent memory leak
    if (this.lastObserver) {
      this.lastObserver.complete();
    }
    this._scanCallId = new Date().getTime();

    this.keyboardInput = keyboardInput;
    this.outputProfileIndex = outputProfileIndex;

    return new Observable(observer => {
      this.lastObserver = observer;
      Promise.all([
        this.settings.getPreferFrontCamera(), // 0
        this.settings.getEnableLimitBarcodeFormats(), // 1
        this.settings.getBarcodeFormats(), // 2
        this.settings.getQuantityType(), // 3
        this.settings.getContinueModeTimeout(), // 4
        this.settings.getDeviceName(), // 5
        this.getOutputProfile(outputProfileIndex), //6
        this.settings.getTorchOn(), // 7
      ]).then(async result => {
        // parameters
        let preferFrontCamera = result[0];
        let enableLimitBarcodeFormats = result[1];
        this.barcodeFormats = result[2];
        let quantityType = result[3];
        let continueModeTimeout = result[4];
        this.deviceName = result[5];
        this.outputProfile = result[6];
        let torchOn = result[7];
        let blockingOutputComponents = OutputProfileModel.HasBlockingOutputComponents(this.outputProfile);

        // other computed parameters
        this.quantityType = quantityType || 'number';
        switch (scanMode) {
          case SelectScanningModePage.SCAN_MODE_ENTER_MAUALLY: this.acqusitionMode = 'manual'; break;
          case SelectScanningModePage.SCAN_MODE_SINGLE: this.acqusitionMode = 'single'; break;
          case SelectScanningModePage.SCAN_MODE_CONTINUE: {
            this.acqusitionMode = 'continue';
            if (blockingOutputComponents || !this.platform.is('android') || continueModeTimeout) {
              this.acqusitionMode = 'mixed_continue';
            }
            break;
          }
        }

        // native plugin options
        let pluginOptions: BarcodeScannerOptions = {
          showFlipCameraButton: true,
          prompt: Config.DEFAULT_ACQUISITION_LABEL, // supported on Android only
          showTorchButton: true,
          preferFrontCamera: preferFrontCamera,
          torchOn: torchOn,
          continuousMode: this.acqusitionMode == 'continue',
        };
        if (enableLimitBarcodeFormats) {
          pluginOptions.formats = this.barcodeFormats.filter(barcodeFormat => barcodeFormat.enabled).map(barcodeFormat => barcodeFormat.name).join(',');
        }
        this.pluginOptions = pluginOptions;

        // used to prevent infinite loops.
        let resetAgainCountTimer;
        let againCount = 0;
        let prevScanDisplayValue = '';

        // used to prevent scan(), and thus again() calls overlaps
        let _scanCallId = this._scanCallId;

        // again() encapsulates the part that need to be repeated when
        // the continuos mode or manual mode are active
        let again = async () => {

          // cancel the previus outputProfile exection. (needed for continue mode?)
          if (_scanCallId != this._scanCallId) {
            observer.complete()
            return;
          }

          // infinite loop detetion
          if (againCount > 30) {
            // Example of infinite loop:
            //
            // Output template = [IF(false)] [BARCODE] [ENDIF]
            // In this case it would repeat  the outputProfile
            // indefinitelly without prompting the user because there
            // isn't a blocking component that can give the opportunity
            // to press back and cancel the scan.
            // It may happen also when there is no BARCODE component or
            // when the if contains a syntax error.
            let wantToContinue = await this.showPreventInfiniteLoopDialog();
            if (!wantToContinue) {
              // this code fragment is duplicated for the 'quantity', 'if' and 'barcode' blocks and in the againCount condition
              observer.complete();
              return; // returns the again() function
            }
          }

          // scan result
          let scan = new ScanModel();
          let now = new Date().getTime();
          // cloning the the outputProfile object is important since the if/endif
          // blocks may remove elements
          scan.outputBlocks = JSON.parse(JSON.stringify(this.outputProfile.outputBlocks))
          scan.id = now;
          scan.repeated = false;
          scan.date = now;

          // variables that can be used in the 'function' and 'if' OutputBlocks
          let variables = {
            barcode: '',
            barcodes: [],
            quantity: null,
            timestamp: (scan.date * 1000),
            device_name: this.deviceName,
          }

          // run the OutputProfile
          for (let i = 0; i < scan.outputBlocks.length; i++) {
            let outputBlock = scan.outputBlocks[i];

            // Prepare the label for an eventual barcode acqusition
            if (outputBlock.label) {
              pluginOptions.prompt = outputBlock.label
            } else {
              // Always clear the label for the next acquisition
              pluginOptions.prompt = Config.DEFAULT_ACQUISITION_LABEL;
            }

            switch (outputBlock.type) {
              // some components like 'key' and 'text', do not need any processing from the
              // app side, so we just skip them
              case 'key': break;
              case 'text': break;
              // while other components like 'variable' need to be filled with data, that is
              // acquired from the smartphone
              case 'variable': {
                switch (outputBlock.value) {
                  case 'deviceName': outputBlock.value = this.deviceName; break;
                  case 'timestamp': outputBlock.value = (scan.date * 1000) + ''; break;
                  case 'date': outputBlock.value = new Date(scan.date).toLocaleDateString(); break;
                  case 'time': outputBlock.value = new Date(scan.date).toLocaleTimeString(); break;
                  case 'date_time': outputBlock.value = new Date(scan.date).toLocaleTimeString() + ' ' + new Date(scan.date).toLocaleDateString(); break;
                  case 'scan_session_name': outputBlock.value = scanSession.name; break;
                  case 'quantity': {
                    try {
                      outputBlock.value = await this.getQuantity(outputBlock.label);
                    } catch (err) {
                      // this code fragment is duplicated for the 'quantity', 'if' and 'barcode' blocks and in the againCount condition
                      observer.complete();
                      return; // returns the again() function
                    }
                    // it's ok to always include the quantity variable, since even if the user
                    // doesn't have the license he won't be able to create the output profile
                    variables.quantity = outputBlock.value;
                    scan.quantity = outputBlock.value; // backwards compatibility
                    break;
                  }
                } // switch outputBlock.value
                break;
              }
              case 'select_option': {
                outputBlock.value = new Supplant().text(outputBlock.value, variables);
                outputBlock.value = await this.showSelectOption(outputBlock.value);
                break;
              }
              case 'function': {
                try {
                  outputBlock.value = this.evalCode(outputBlock.value, variables);
                } catch (error) {
                  outputBlock.value = '';
                }
                break;
              }
              case 'barcode': {
                try {
                  let barcode = await this.getBarcode(outputBlock.label);

                  // Context:
                  //
                  // Since we don't know if the user wants to start a new scan() or if he/she wants
                  // to add more scannings, we always call again() wich will get stuck in the Promise
                  // of the line above that waits for a text input (or camera acquisition).
                  //
                  // If the user starts a new scan() and this an new OutputProfile executuion
                  // (by clicking the FAB), we have to drop the barcode that will acquired from
                  // the stuck again(), and also call return; to prevent other components to be exceuted.
                  //
                  // The same thing could happen with await getQuantity() and await getSelectOption()
                  // but since there isn't a way to press the FAB button and create a new scan() without
                  // closing the alert, they won't never get stuck.
                  if (_scanCallId != this._scanCallId) {
                    observer.complete()
                    return;
                  }

                  variables.barcode = barcode;
                  variables.barcodes.push(barcode);
                  outputBlock.value = barcode;
                } catch (err) {
                  // this code fragment is duplicated for the 'quantity', 'if' and 'barcode' blocks and in the againCount condition
                  observer.complete();
                  return; // returns the again() function
                }
              }
              case 'delay': break;
              case 'run':
              case 'http': {
                // injects variables (interpolation)
                // Example:
                // 'http://localhost/?a={{ barcode }}' becomes 'http://localhost/?a=123456789'
                outputBlock.value = new Supplant().text(outputBlock.value, variables);
                break;
              }
              case 'if': {
                let condition = false;
                try {
                  condition = this.evalCode(outputBlock.value, variables);
                } catch (error) {
                  // if the condition cannot be evaluated we must stop
                  // TODO stop only if the acusitionMode is manual? Or pop-back?

                  // this code fragment is duplicated for the 'quantity', 'if' and 'barcode' blocks and in the againCount condition
                  observer.complete();
                  return; // returns the again() function
                }
                // the current i value is pointing to the 'if' block, we start searching from
                // the next block, that is the (i + 1)th
                let endIfIndex = OutputBlockModel.FindEndIfIndex(scan.outputBlocks, i + 1);
                if (condition == true) {
                  // if the condition is true we remove only the 'if' and 'endif' bloks

                  // remove 'if'
                  scan.outputBlocks.splice(i, 1);

                  // remove 'endif'
                  // since we removed 1 block, now we have to add -1 offset in order
                  // to remove the 'endif'
                  scan.outputBlocks.splice(endIfIndex - 1, 1);
                } else {
                  // if the condition is false, we must branch, so we remove the blocks
                  // inside the 'if' (including the current block that is an 'if') and the 'endif'
                  // splice(startFrom (included), noElementsToRemove (included))
                  let count = endIfIndex - i + 1;
                  scan.outputBlocks.splice(i, count);
                }
                // since we always remove the 'if' block, we won't need to point to the next
                // block, because the latter will take the place of the current 'if' block.
                // To do that we just decrease i, in order to compensate the increment performed
                // by the for cycle
                i--;
                break;
              }

            } // switch outputBlock.type
          } // for

          /**
          * @deprecated backwards compatibility
          */
          scan.text = scan.outputBlocks.map(outputBlock => {
            if (outputBlock.type == 'barcode') {
              return outputBlock.value;
            } else {
              return '';
            }
          }).filter(x => x != '').join(' ');
          // end backwards compatibility

          scan.displayValue = ScanModel.ToString(scan);

          // prevent infinite loops
          if (scan.displayValue == prevScanDisplayValue) {
            againCount++;
          }
          prevScanDisplayValue = scan.displayValue;
          if (resetAgainCountTimer) clearTimeout(resetAgainCountTimer);
          resetAgainCountTimer = setTimeout(() => againCount = 0, 500);

          observer.next(scan);

          // decide how and if repeat the outputBlock
          switch (this.acqusitionMode) {
            case 'continue':
              again();
              break;
            case 'mixed_continue':
              this.showAddMoreDialog(continueModeTimeout).then((addMore) => {
                if (addMore) {
                  again(); // if the user clicks yes => loop
                } else {
                  observer.complete();
                }
              })
              break;
            case 'manual':
              again();
              break;
            case 'single':
              observer.complete();
              break;
            default:
              observer.complete();
              break;
          } // switch
        } // again function
        again(); // starts the loop for the first time
      });
    })
  }

  // We need to store lastResolve and lastReject because when the continuos
  // mode is in use, we have to forward the resulting barcode of the
  // subscription to the last getBarcode promise.
  // lastReject and lastResolve relay on the fact that it will never be
  // simultanius calls to getBarcode() method, it will always be called
  // sequencially. The explaination is that the loop contained in the scan()
  // method isn't allowed to go haed until the previus getBarcode doesn't get
  // resolved.
  private lastResolve;
  private lastReject;
  private continuosScanSubscription: Subscription = null;

  private getBarcode(label = null): Promise<string> {
    this.awaitingForBarcode = true;

    let promise = new Promise<string>(async (resolve, reject) => {
      switch (this.acqusitionMode) {
        case 'single':
        case 'mixed_continue': {
          let barcodeScanResult: BarcodeScanResult = await this.barcodeScanner.scan(this.pluginOptions).first().toPromise();
          if (!barcodeScanResult || barcodeScanResult.cancelled) {
            reject('cancelled');
            return;
          }
          // CODE_39 fix (there is a copy of this fix in the CONTINUE mode part, if you change this then you have to change also the other one )
          if (barcodeScanResult.text && barcodeScanResult.format == 'CODE_39' && this.barcodeFormats.findIndex(x => x.enabled && x.name == 'CODE_32') != -1) {
            barcodeScanResult.text = Utils.convertCode39ToCode32(barcodeScanResult.text);
          }
          // END CODE_39 fix
          resolve(barcodeScanResult.text);
          break;
        }
        // It is used only if there is no quantity and the user selected
        // the continuos mode. The only way to exit is to press cancel.
        //
        // Practically getBarcodes is called indefinitelly until it
        // doesn't reject() the returned promise (cancel press).
        //
        // Since the exit condition is inside this method, we just
        // accumulate barcodes indefinitely, they will always be
        // consumed from the caller.
        case 'continue': {
          this.lastResolve = resolve;
          this.lastReject = reject;

          if (this.continuosScanSubscription == null) {
            this.continuosScanSubscription = this.barcodeScanner.scan(this.pluginOptions).subscribe(barcodeScanResult => {
              if (!barcodeScanResult || barcodeScanResult.cancelled) {
                this.continuosScanSubscription.unsubscribe();
                this.continuosScanSubscription = null;
                this.lastReject();
                return; // returns the promise executor function
              }

              // CODE_39 fix (there is a copy of this fix in the SINGLE mode part, if you change this then you have to change also the other one )
              if (barcodeScanResult.text && barcodeScanResult.format == 'CODE_39' && this.barcodeFormats.findIndex(x => x.enabled && x.name == 'CODE_32') != -1) {
                barcodeScanResult.text = Utils.convertCode39ToCode32(barcodeScanResult.text);
              }
              // END CODE_39 fix
              this.lastResolve(barcodeScanResult.text);
            }, error => {
              // this should never be called
            }, () => {
              // this should never be called
            })
          }
          break;
        }

        case 'manual': {
          this.keyboardInput.focus(true);
          this.keyboardInput.setPlaceholder(label);
          // here we don't wrap the promise inside a try/catch statement because there
          // isn't a way to cancel a manual barcode acquisition
          resolve(await this.keyboardInput.onSubmit.first().toPromise());
          break;
        }
      } // switch acqusitionMode
    }); // promise

    promise
      .then(value => { this.awaitingForBarcode = false; })
      .catch(err => { this.awaitingForBarcode = false; })
    return promise;
  }

  public async updateCurrentOutputProfile() {
    this.outputProfile = await this.getOutputProfile(this.outputProfileIndex);
  }

  // getOutputProfile() is called in two separated places, that's why is
  // separated from the updateOutputProfile() method.
  private async getOutputProfile(i): Promise<OutputProfileModel> {
    let profiles = await this.settings.getOutputProfiles();
    return new Promise<OutputProfileModel>((resolve, reject) => {
      // Prevent OutOfBounds. The same logic is duplciated in the SelectScanningModePage/ionViewWillEnter() method
      if (i >= profiles.length) i = profiles.length - 1;
      resolve(profiles[i]);
    });
  }

  private showSelectOption(csvSelectOptions: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let options = csvSelectOptions.split(',');
      let optionIndex = 0;
      let inputs: AlertInputOptions[] = options.map(option => {
        let input: AlertInputOptions = {
          type: 'radio',
          label: option,
          value: option,
        };
        if (optionIndex == 0) {
          input.checked = true;
        }
        optionIndex++;
        return input;
      });

      let alert = this.alertCtrl.create({
        title: 'Select an option',
        inputs: inputs,
        enableBackdropDismiss: false,
        buttons: [{
          text: 'Ok',
          handler: (data: any) => {
            resolve(data);
          }
        }]
      });
      alert.setLeavingOpts({ keyboardClose: false, animate: false });
      alert.present({ keyboardClose: false, animate: false });
    });
  }

  private getQuantity(label = null): Promise<string> { // doesn't need to be async becouse doesn't contain awaits
    return new Promise((resolve, reject) => {
      let alert = this.alertCtrl.create({
        title: label ? label : 'Enter quantity value',
        // message: 'Inse',
        enableBackdropDismiss: false,
        inputs: [{ name: 'quantity', type: this.quantityType, placeholder: this.quantityType == 'number' ? '(Default is 1, press Ok to insert it)' : 'Eg. ten' }],
        buttons: [{
          role: 'cancel', text: 'Cancel',
          handler: () => {
            reject('cancelled');
          }
        }, {
          text: 'Ok',
          handler: data => {
            if (data.quantity) { // && isNumber(data.quantity)
              resolve(data.quantity)
            } else if (this.quantityType == 'number') {
              resolve('1')
            }
          }
        }]
      });
      alert.setLeavingOpts({ keyboardClose: false, animate: false });
      alert.present({ keyboardClose: false, animate: false });
    });
  }

  private showAddMoreDialog(timeoutSeconds): Promise<boolean> {
    return new Promise((resolve, reject) => {
      let interval = null;
      let alert = this.alertCtrl.create({
        title: 'Continue scanning?',
        message: 'Do you want to add another item to this scan session?',
        buttons: [{
          text: 'Stop', role: 'cancel',
          handler: () => {
            if (interval) clearInterval(interval);
            resolve(false);
          }
        }, {
          text: 'Continue', handler: () => {
            if (interval) clearInterval(interval);
            resolve(true);
          }
        }]
      });
      alert.present();
      this.firebaseAnalytics.logEvent('custom_timeout', {});
      interval = setInterval(() => {
        this.ngZone.run(() => {
          alert.setSubTitle('Timeout: ' + timeoutSeconds);
        })
        if (!timeoutSeconds || timeoutSeconds <= 0) {
          if (interval) clearInterval(interval);
          alert.dismiss();
          resolve(true);
        }
        timeoutSeconds--;
      }, 1000);
    });
  }

  private showPreventInfiniteLoopDialog(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.alertCtrl.create({
        title: 'Infinite loop detected',
        message: 'Perhaps you forgot to put the BARCODE component, or you have a condition that is always false. Check your Output template. Do you want to continue?',
        buttons: [{
          text: 'Stop', role: 'cancel',
          handler: () => {
            resolve(false);
          }
        }, {
          text: 'Continue', handler: () => {
            resolve(true);
          }
        }]
      }).present();
    });
  }

  /**
   * Injects variables like barcode, device_name, date and evaluates
   * the string parameter
   */
  private evalCode(code: string, variables: any) {
    // Inject variables
    let randomInt = this.getRandomInt() + '';
    // Typescript transpiles local variables such **barcode** and changes their name.
    // When eval() gets called it doesn't find the **barcode** variable and throws a syntax error.
    // To prevent that i store the barcode inside the variable **window** which doesn't change.
    // I use the randomInt as index insted of a fixed string to enforce mutual exclusion
    Object.defineProperty(window, randomInt, { value: {}, writable: true });
    Object.keys(variables).forEach(key => {
      // console.log('key: ', key);
      window[randomInt]['_' + key] = variables[key]; // i put the index like a literal, since randomInt can be transpiled too
      code = code.replace(new RegExp(key, 'g'), 'window["' + randomInt + '"]["_' + key + '"]');
    });

    // Run code
    try {
      return eval(code);
    } catch (error) {
      this.alertCtrl.create({
        title: 'Error',
        message: 'An error occurred while executing your Output template: ' + error,
        buttons: [{ text: 'Ok', role: 'cancel', }]
      }).present();
      throw new Error(error);
    } finally {
      // executed in either case before returning
      delete window[randomInt];
    }

    // Note:
    //     The previous solution: stringComponent.value.replace('barcode', '"' + barcode + '"');
    //     didn't always work because the **barcode** value is treated as a string immediately.
    //
    //  ie:
    //
    //     "this is
    //        as test".replace(...)
    //
    //     doesn't work because the first line doesn't have the ending \ character.
  }

  getRandomInt(max = Number.MAX_SAFE_INTEGER) {
    return Math.floor(Math.random() * Math.floor(max));
  }
}
